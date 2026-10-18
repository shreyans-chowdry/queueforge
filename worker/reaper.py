"""Recover expired leases independently of worker processes."""
import json
import time

from common.db import SessionLocal
from common.models import Job, JobStatus
from common.lifecycle import publish_state, record_failure, sync_outcome
from common.queue_engine import ack, get_all_workers, get_now_ms
from common.redis_client import redis_client


def recover_job(job_id, worker_id):
    with SessionLocal() as db:
        job = db.query(Job).filter(Job.id == job_id).with_for_update().first()
        # Recheck under the row lock: another reaper or heartbeat may have acted.
        expiry = redis_client.zscore(f"queue:processing:{worker_id}", job_id)
        if expiry is None or expiry > get_now_ms():
            return
        if not job:
            ack(job_id, worker_id)
        elif job.status == JobStatus.processing and job.worker_id == worker_id:
            record_failure(db, job, worker_id, f"Worker {worker_id} lost its lease. Recovered by Reaper.")
        elif job.status in (JobStatus.pending, JobStatus.delayed) and job.worker_id is None:
            # The worker may have died before marking processing, or after
            # committing a retry but before moving its Redis lease.
            if job.status == JobStatus.pending:
                record_failure(db, job, worker_id, "Worker crashed before starting the job.")
            else:
                sync_outcome(job, worker_id)
                publish_state(job)
        else:
            # Completion was committed before a crash, or this is an obsolete lease.
            if job.status == JobStatus.dead_letter:
                sync_outcome(job, worker_id)
            else:
                ack(job_id, worker_id)


def reap_once():
    now = get_now_ms()
    for worker_id, data in get_all_workers().items():
        if now - data.get("last_seen", 0) > 3600_000:
            redis_client.hdel("workers:registry", worker_id)
        elif data.get("status") == "alive" and now - data.get("last_seen", 0) > 15000:
            # Compare and set so a concurrent heartbeat cannot be overwritten.
            updated = {**data, "status": "dead"}
            redis_client.eval("""
                if redis.call('HGET', KEYS[1], ARGV[1]) == ARGV[2] then
                    redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
                end
            """, 1, "workers:registry", worker_id, json.dumps(data), json.dumps(updated))

    # SCAN avoids blocking Redis as the cluster grows.
    for key in redis_client.scan_iter(match="queue:processing:*"):
        worker_id = key.removeprefix("queue:processing:")
        for job_id in redis_client.zrangebyscore(key, 0, now):
            recover_job(job_id, worker_id)


def run_reaper():
    print("Starting reaper process...")
    while True:
        try:
            reap_once()
        except Exception as exc:
            print(f"Reaper encountered an error: {exc}")
        time.sleep(10)


if __name__ == "__main__":
    run_reaper()
