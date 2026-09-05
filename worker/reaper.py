import time
import json
from common.db import SessionLocal
from common.models import Job, JobStatus
from common.queue_engine import (
    get_now_ms,
    requeue_with_backoff,
    publish_job_event,
    get_all_workers,
    move_to_dead_letter
)
from common.redis_client import redis_client

# WHY THE REAPER IS A SEPARATE PROCESS:
# If a worker process completely crashes (e.g., OOM kill, segfault, hardware failure), 
# it stops executing code and obviously cannot run its own local error-handling or 
# recovery logic to unlock jobs it was processing.
# By having a completely separate Reaper process running independently, we guarantee 
# that abandoned jobs and stale heartbeat records are detected externally and 
# cleaned up reliably without depending on the crashed process.

def run_reaper():
    print("Starting reaper process...")
    while True:
        try:
            now = get_now_ms()
            
            # 1. Scan the registry for workers whose heartbeat has flatlined
            workers = get_all_workers()
            for w_id, w_data in workers.items():
                last_seen = w_data.get("last_seen", 0)
                # If dead for more than 1 hour, prune from hash to prevent memory leak
                if now - last_seen > 3600_000:
                    redis_client.hdel("workers:registry", w_id)
                    continue

                if w_data.get("status") == "alive":
                    if now - last_seen > 15000:
                        print(f"Reaper: Worker {w_id} is dead. Last seen {now - last_seen}ms ago.")
                        w_data["status"] = "dead"
                        redis_client.hset("workers:registry", w_id, json.dumps(w_data))

            # 2. Scan processing queues for abandoned jobs (visibility timeout expired)
            processing_queues = redis_client.keys("queue:processing:*")
            for queue_key in processing_queues:
                worker_id = queue_key.split("queue:processing:")[-1]
                
                # Find all jobs in this queue where the score (timeout) is <= now
                stale_jobs = redis_client.zrangebyscore(queue_key, 0, now)
                
                for job_id_str in stale_jobs:
                    print(f"Reaper: Recovering abandoned job {job_id_str} from {worker_id}")
                    with SessionLocal() as db:
                        job = db.query(Job).filter(Job.id == job_id_str).first()
                        if job:
                            job.attempts += 1
                            job.error = f"Worker {worker_id} crashed. Recovered by Reaper."
                            
                            # Treat exactly like a retry
                            if job.attempts < job.max_retries:
                                job.status = JobStatus.delayed
                                requeue_with_backoff(job_id_str, worker_id, job.attempts)
                                publish_job_event(
                                    job_id_str, 
                                    JobStatus.delayed.value,
                                    worker_id=worker_id,
                                    attempts=job.attempts,
                                    error=job.error
                                )
                            else:
                                job.status = JobStatus.dead_letter
                                move_to_dead_letter(job_id_str, worker_id)
                                publish_job_event(
                                    job_id_str, 
                                    JobStatus.dead_letter.value,
                                    worker_id=worker_id,
                                    attempts=job.attempts,
                                    error=job.error
                                )
                            
                            db.commit()
                        else:
                            # Job doesn't exist in DB anymore, just remove it from Redis
                            redis_client.zrem(queue_key, job_id_str)

        except Exception as e:
            print(f"Reaper encountered an error: {e}")
        
        # Loop every ~10 seconds
        time.sleep(10)

if __name__ == "__main__":
    run_reaper()
