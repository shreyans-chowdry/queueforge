import pytest
import time
from common.queue_engine import (
    enqueue, dequeue, promote_due_delayed_jobs, requeue_with_backoff, get_now_ms
)
from common.redis_client import redis_client

@pytest.fixture(autouse=True)
def setup_teardown():
    # Clean the database before tests
    redis_client.flushdb()
    yield
    # Clean up after tests
    redis_client.flushdb()

def test_priority_dequeuing():
    # Enqueue a low priority job first
    enqueue("job_low", priority=1)
    
    # Sleep briefly to ensure the high priority job has a later enqueue time
    time.sleep(0.05)
    
    # Enqueue a high priority job later
    enqueue("job_high", priority=10)
    
    worker_id = "worker_1"
    
    # The high priority job should be dequeued first, despite being enqueued later
    first_job = dequeue(worker_id, visibility_timeout_ms=5000)
    assert first_job == "job_high"
    
    # The low priority job should be dequeued second
    second_job = dequeue(worker_id, visibility_timeout_ms=5000)
    assert second_job == "job_low"
    
    # No more jobs in queue
    assert dequeue(worker_id, 5000) is None

def test_delayed_job():
    worker_id = "worker_1"
    future_time = get_now_ms() + 1000 # 1 second in the future
    
    # Enqueue a job with a future execution time
    enqueue("job_delayed", priority=5, execute_at=future_time)
    
    # It should not be available in pending queue immediately
    assert dequeue(worker_id, visibility_timeout_ms=5000) is None
    
    # Attempting to promote jobs before the delay expires shouldn't move it
    promote_due_delayed_jobs()
    assert dequeue(worker_id, visibility_timeout_ms=5000) is None

def test_requeue_with_backoff():
    job_id = "job_retry"
    worker_id = "worker_1"
    
    # Add a mock job to processing queue to simulate it being processed
    redis_client.zadd(f"queue:processing:{worker_id}", {job_id: get_now_ms() + 5000})
    
    # Attempt 1 -> Base Delay: 2000ms + Jitter
    requeue_with_backoff(job_id, worker_id, attempt=1, base_delay_ms=1000, max_delay_ms=60000)
    score1 = redis_client.zscore("queue:delayed", job_id)
    assert score1 is not None
    
    # Clean up and mock processing again
    redis_client.zrem("queue:delayed", job_id)
    redis_client.zadd(f"queue:processing:{worker_id}", {job_id: get_now_ms() + 5000})
    
    # Attempt 2 -> Base Delay: 4000ms + Jitter
    requeue_with_backoff(job_id, worker_id, attempt=2, base_delay_ms=1000, max_delay_ms=60000)
    score2 = redis_client.zscore("queue:delayed", job_id)
    
    # The delay calculated in attempt 2 should be strictly greater than attempt 1's delay
    # Score 1 is roughly Now + 2000-3000ms. Score 2 is roughly Now' + 4000-6000ms.
    # We add 500ms safety buffer to ensure strict increasing logic is verified.
    assert score2 > score1 + 500
