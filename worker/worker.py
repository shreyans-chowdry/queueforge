import time
import socket
import uuid
import json
import random
import threading
import hashlib
from datetime import datetime, timezone

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
        Safely validates parameters to prevent unbounded stalls or DoS.
        """
        job_type = payload.get("type", "sleep")
        if job_type == "sleep":
            seconds = min(max(0.0, float(payload.get("seconds", 1))), 300.0)
            time.sleep(seconds)
        elif job_type == "compute":
            # Simulate a CPU-bound calculation by hashing repeatedly
            iterations = min(max(1, int(payload.get("iterations", 500_000))), 2_000_000)
            data = b"queueforge"
            for _ in range(iterations):
                data = hashlib.sha256(data).digest()
        elif job_type == "flaky":
            # Exercise the retry path ~30% of the time
            if random.random() < 0.3:
                raise Exception("Random flaky failure!")
            time.sleep(0.2)
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
                    job.started_at = datetime.now(timezone.utc)
                    job.worker_id = WORKER_ID
                    db.commit()
                    publish_job_event(
                        job_id_str, 
                        JobStatus.processing.value,
                        worker_id=WORKER_ID,
                        attempts=job.attempts
                    )

                    # 4. Execute the payload
                    try:
                        self.execute_job(job.payload)
                        
                        # 5. On success: update DB, acknowledge, and broadcast
                        job.status = JobStatus.completed
                        job.completed_at = datetime.now(timezone.utc)
                        db.commit()
                        
                        ack(job_id_str, WORKER_ID)
                        publish_job_event(
                            job_id_str, 
                            JobStatus.completed.value,
                            worker_id=WORKER_ID,
                            attempts=job.attempts
                        )

                    except Exception as e:
                        # 6. On exception: handle retries
                        job.attempts += 1
                        job.error = str(e)
                        
                        if job.attempts < job.max_retries:
                            # RETRY DECISION:
                            # Exponentially increasing delay
                            job.status = JobStatus.delayed
                            requeue_with_backoff(job_id_str, WORKER_ID, job.attempts)
                            publish_job_event(
                                job_id_str, 
                                JobStatus.delayed.value,
                                worker_id=WORKER_ID,
                                attempts=job.attempts,
                                error=job.error
                            )
                        else:
                            # EXHAUSTED RETRIES:
                            # Move to dead letter queue
                            job.status = JobStatus.dead_letter
                            move_to_dead_letter(job_id_str, WORKER_ID)
                            publish_job_event(
                                job_id_str, 
                                JobStatus.dead_letter.value,
                                worker_id=WORKER_ID,
                                attempts=job.attempts,
                                error=job.error
                            )
                            
                        db.commit()

                self.current_job_id = None

            except Exception as e:
                print(f"Worker main loop encountered an error: {e}")
                time.sleep(5)

if __name__ == "__main__":
    worker = Worker()
    worker.run()
