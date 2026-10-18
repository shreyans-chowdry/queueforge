import time
import socket
import uuid
import random
import threading
import hashlib
from datetime import datetime, timezone

from common.db import SessionLocal
from common.models import Job, JobStatus
from common.lifecycle import record_failure, publish_state, sync_outcome
from common.queue_engine import (
    promote_due_delayed_jobs,
    dequeue,
    ack,
    update_worker_registry,
    renew_lease
)

WORKER_ID = f"{socket.gethostname()}-{uuid.uuid4().hex[:8]}"

class Worker:
    def __init__(self):
        self.current_job_id = None
        self.running = True
        self.stop_event = threading.Event()

    def heartbeat_loop(self):
        """
        Background thread that updates the worker's status in the registry every 5 seconds.
        """
        while self.running:
            try:
                job_id = self.current_job_id
                if job_id:
                    renew_lease(job_id, WORKER_ID)
                update_worker_registry(WORKER_ID, "alive", job_id)
            except Exception as exc:
                # A transient outage must not permanently kill lease renewal.
                print(f"Heartbeat failed: {exc}")
            self.stop_event.wait(5)

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

    def process_job(self, job_id):
        self.current_job_id = job_id
        try:
            with SessionLocal() as db:
                job = db.query(Job).filter(Job.id == job_id).with_for_update().first()
                if not job:
                    ack(job_id, WORKER_ID)
                    return
                if not renew_lease(job_id, WORKER_ID):
                    return
                if job.status not in (JobStatus.pending, JobStatus.delayed):
                    sync_outcome(job, WORKER_ID)
                    return
                job.status = JobStatus.processing
                job.started_at = datetime.now(timezone.utc)
                job.completed_at = None
                job.worker_id = WORKER_ID
                payload = job.payload
                db.commit()
                publish_state(job)

            # Do not hold a database connection/transaction while executing work.
            error = None
            try:
                self.execute_job(payload)
            except Exception as exc:
                error = exc

            with SessionLocal() as db:
                job = db.query(Job).filter(Job.id == job_id).with_for_update().first()
                # A stale executor must never overwrite a recovered job's outcome.
                if (not job or job.status != JobStatus.processing
                        or job.worker_id != WORKER_ID or not renew_lease(job_id, WORKER_ID)):
                    return
                if error is not None:
                    record_failure(db, job, WORKER_ID, error)
                else:
                    job.status = JobStatus.completed
                    job.completed_at = datetime.now(timezone.utc)
                    job.error = None
                    db.commit()
                    ack(job_id, WORKER_ID)
                    publish_state(job)
        finally:
            self.current_job_id = None

    def run(self):
        print(f"Starting worker {WORKER_ID}")
        update_worker_registry(WORKER_ID, "alive")
        heartbeat_thread = threading.Thread(target=self.heartbeat_loop, daemon=True)
        heartbeat_thread.start()
        try:
            while self.running:
                try:
                    promote_due_delayed_jobs()
                    job_id = dequeue(WORKER_ID, visibility_timeout_ms=30000)
                    if job_id:
                        self.process_job(job_id)
                    else:
                        self.stop_event.wait(1)
                except Exception as exc:
                    print(f"Worker main loop encountered an error: {exc}")
                    self.stop_event.wait(5)
        finally:
            self.running = False
            self.stop_event.set()
            heartbeat_thread.join(timeout=6)
            update_worker_registry(WORKER_ID, "dead")


if __name__ == "__main__":
    Worker().run()
