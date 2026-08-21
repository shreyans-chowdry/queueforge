import time
import socket
import uuid
import json
import random
import threading
import hashlib
from datetime import datetime

from common.db import SessionLocal
from common.models import Job, JobStatus
from common.queue_engine import (
    promote_due_delayed_jobs,
    dequeue,
    ack,
    requeue_with_backoff,
    move_to_dead_letter,
    publish_job_event,
    update_worker_registry
)

WORKER_ID = f"{socket.gethostname()}-{uuid.uuid4().hex[:8]}"

class Worker:
    def __init__(self):
        self.current_job_id = None
        self.running = True

    def heartbeat_loop(self):
        """
        Background thread that updates the worker's status in the registry every 5 seconds.
        """
        while self.running:
            update_worker_registry(WORKER_ID, "alive", self.current_job_id)
            time.sleep(5)

    def execute_job(self, payload):
        """
        Executes the job based on its payload type.
        Supports demo tasks: sleep, compute, flaky.
        """
        job_type = payload.get("type", "sleep")
        if job_type == "sleep":
            time.sleep(payload.get("seconds", 1))
        elif job_type == "compute":
            # Simulate a CPU-bound calculation by hashing repeatedly
            data = b"queueforge"
            for _ in range(1_000_000):
                data = hashlib.sha256(data).digest()
        elif job_type == "flaky":
            # Exercise the retry path ~30% of the time
            if random.random() < 0.3:
                raise Exception("Random flaky failure!")
            time.sleep(0.5)
        else:
            raise ValueError(f"Unknown job type: {job_type}")

    def run(self):
        print(f"Starting worker {WORKER_ID}")
        # Start the heartbeat thread
        update_worker_registry(WORKER_ID, "alive")
        heartbeat_thread = threading.Thread(target=self.heartbeat_loop, daemon=True)
        heartbeat_thread.start()

        while self.running:
            try:
                # 1. Sift delayed jobs into pending if their time has come
                promote_due_delayed_jobs()

                # 2. Try to grab a job with a 30s visibility timeout
                job_id_str = dequeue(WORKER_ID, visibility_timeout_ms=30000)
                if not job_id_str:
                    time.sleep(1)
                    continue
                
                self.current_job_id = job_id_str
                update_worker_registry(WORKER_ID, "alive", self.current_job_id)

                with SessionLocal() as db:
                    job = db.query(Job).filter(Job.id == job_id_str).first()
                    if not job:
                        # Job is missing from Postgres, just clean it up from Redis
                        ack(job_id_str, WORKER_ID)
                        self.current_job_id = None
                        continue

                    # 3. Mark the job as processing
                    job.status = JobStatus.processing
                    job.started_at = datetime.utcnow()
                    job.worker_id = WORKER_ID
                    db.commit()
                    publish_job_event(job_id_str, JobStatus.processing.value)

                    # 4. Execute the payload
                    try:
                        self.execute_job(job.payload)
                        
                        # 5. On success: update DB, acknowledge, and broadcast
                        job.status = JobStatus.completed
                        job.completed_at = datetime.utcnow()
                        db.commit()
                        
                        ack(job_id_str, WORKER_ID)
                        publish_job_event(job_id_str, JobStatus.completed.value)

                    except Exception as e:
                        # 6. On exception: handle retries
                        job.attempts += 1
                        job.error = str(e)
                        
                        if job.attempts < job.max_retries:
                            # RETRY DECISION:
                            # We haven't hit the retry limit yet. We use requeue_with_backoff 
                            # to place the job back in the 'delayed' queue with an exponentially 
                            # increasing delay. This prevents overwhelming the system or external 
                            # APIs, giving transient errors a realistic window to resolve themselves.
                            job.status = JobStatus.delayed
                            requeue_with_backoff(job_id_str, WORKER_ID, job.attempts)
                            publish_job_event(job_id_str, JobStatus.delayed.value)
                        else:
                            # EXHAUSTED RETRIES:
                            # The job persistently failed and maxed out its attempts. 
                            # We move it to the dead letter queue (DLQ) so it doesn't continually 
                            # clog the active pipeline. Developers can inspect DLQ jobs later.
                            job.status = JobStatus.dead_letter
                            move_to_dead_letter(job_id_str, WORKER_ID)
                            publish_job_event(job_id_str, JobStatus.dead_letter.value)
                            
                        db.commit()

                self.current_job_id = None

            except Exception as e:
                print(f"Worker main loop encountered an error: {e}")
                time.sleep(5)

if __name__ == "__main__":
    worker = Worker()
    worker.run()
