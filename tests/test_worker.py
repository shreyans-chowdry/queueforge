from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from common.db import SessionLocal
from common.models import Job, JobStatus
from common.queue_engine import enqueue, dequeue, get_now_ms
from common.redis_client import redis_client
from worker.worker import Worker, WORKER_ID
from worker.reaper import recover_job


def new_job(payload=None):
    with SessionLocal() as db:
        job = Job(payload=payload or {"type": "sleep", "seconds": 0})
        db.add(job)
        db.commit()
        job_id = str(job.id)
    enqueue(job_id)
    assert dequeue(WORKER_ID, 30000) == job_id
    return job_id


def state(job_id):
    with SessionLocal() as db:
        job = db.get(Job, job_id)
        return job.status, job.attempts, job.error


def expire(job_id):
    redis_client.zadd(f"queue:processing:{WORKER_ID}", {job_id: get_now_ms() - 1})


def test_worker_completes_and_clears_lease():
    job_id = new_job()
    worker = Worker()
    worker.process_job(job_id)
    assert state(job_id) == (JobStatus.completed, 0, None)
    assert redis_client.zscore(f"queue:processing:{WORKER_ID}", job_id) is None
    assert worker.current_job_id is None


def test_worker_failure_schedules_retry_and_preserves_error(monkeypatch):
    job_id = new_job()
    worker = Worker()
    def fail(payload):
        raise ValueError("transient failure")
    monkeypatch.setattr(worker, "execute_job", fail)
    worker.process_job(job_id)
    assert state(job_id) == (JobStatus.delayed, 1, "transient failure")
    assert redis_client.zscore("queue:delayed", job_id) > get_now_ms()


def test_stale_executor_cannot_overwrite_recovery(monkeypatch):
    job_id = new_job()
    worker = Worker()
    def recover_during_execution(payload):
        expire(job_id)
        recover_job(job_id, WORKER_ID)
    monkeypatch.setattr(worker, "execute_job", recover_during_execution)
    worker.process_job(job_id)
    status, attempts, error = state(job_id)
    assert status == JobStatus.delayed and attempts == 1 and "lease" in error
    assert redis_client.zscore("queue:delayed", job_id) is not None


def test_two_reapers_do_not_double_increment_or_resurrect_completed_job():
    job_id = new_job()
    with SessionLocal() as db:
        job = db.get(Job, job_id)
        job.status = JobStatus.processing
        job.worker_id = WORKER_ID
        db.commit()
    expire(job_id)
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(lambda _: recover_job(job_id, WORKER_ID), range(2)))
    assert state(job_id)[1] == 1
    # Completion persisted but Redis acknowledgement was interrupted.
    with SessionLocal() as db:
        job = db.get(Job, job_id)
        job.status = JobStatus.completed
        job.completed_at = datetime.now(timezone.utc)
        db.commit()
    redis_client.zrem("queue:delayed", job_id)
    expire(job_id)
    recover_job(job_id, WORKER_ID)
    assert state(job_id)[0] == JobStatus.completed
    assert redis_client.zscore("queue:delayed", job_id) is None


def test_reaper_ignores_live_lease():
    job_id = new_job()
    recover_job(job_id, WORKER_ID)
    assert state(job_id)[1] == 0
    assert redis_client.zscore(f"queue:processing:{WORKER_ID}", job_id) > get_now_ms()


def test_heartbeat_renews_lease_and_survives_a_transient_outage(monkeypatch):
    import worker.worker as module
    worker = Worker()
    worker.current_job_id = "long_job"
    calls = []
    def renewal(*args):
        calls.append(args)
        if len(calls) == 1:
            raise ConnectionError("temporary outage")
        return True
    def tick(_):
        if len(calls) == 2:
            worker.running = False
    monkeypatch.setattr(module, "renew_lease", renewal)
    monkeypatch.setattr(worker.stop_event, "wait", tick)
    worker.heartbeat_loop()
    assert len(calls) == 2


def test_pubsub_failure_does_not_abort_execution(monkeypatch):
    from redis.exceptions import ConnectionError
    import common.lifecycle as lifecycle
    def unavailable(*args, **kwargs):
        raise ConnectionError("pubsub unavailable")
    monkeypatch.setattr(lifecycle, "publish_job_event", unavailable)
    job_id = new_job()
    Worker().process_job(job_id)
    assert state(job_id)[0] == JobStatus.completed
