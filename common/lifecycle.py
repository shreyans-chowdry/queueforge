"""Database transitions shared by workers and crash recovery.

Lock the row before reading its state. Persist outcomes before queue transitions;
recovery can then repair a crash between the database commit and Redis update.
"""
import logging
from datetime import datetime, timezone
from redis.exceptions import RedisError

from common.models import JobStatus
from common.queue_engine import (
    ack, move_to_dead_letter, publish_job_event, requeue_with_backoff, retry_at_ms,
)


def publish_state(job):
    try:
        publish_job_event(str(job.id), job.status.value, worker_id=job.worker_id,
                          attempts=job.attempts, error=job.error)
    except RedisError:
        logging.getLogger(__name__).exception("Could not publish state for %s", job.id)


def sync_outcome(job, worker_id):
    job_id = str(job.id)
    if job.status == JobStatus.delayed:
        requeue_with_backoff(job_id, worker_id, job.attempts,
                             execute_at=int(job.scheduled_at.timestamp() * 1000))
    elif job.status == JobStatus.dead_letter:
        move_to_dead_letter(job_id, worker_id)
    else:
        ack(job_id, worker_id)


def record_failure(db, job, worker_id, error):
    job.attempts += 1
    job.error = str(error)
    job.worker_id = None
    if job.attempts < job.max_retries:
        job.status = JobStatus.delayed
        job.scheduled_at = datetime.fromtimestamp(retry_at_ms(job.attempts) / 1000, timezone.utc)
    else:
        job.status = JobStatus.dead_letter
        job.completed_at = datetime.now(timezone.utc)
    db.commit()
    sync_outcome(job, worker_id)
    publish_state(job)
