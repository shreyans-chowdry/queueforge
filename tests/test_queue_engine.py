import pytest
import time
from common.queue_engine import (
    enqueue, dequeue, promote_due_delayed_jobs, requeue_with_backoff, get_now_ms
)
from common.redis_client import redis_client

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

def test_delayed_job_priority_preservation():
    """Verify that delayed jobs preserve their original priority when promoted to pending."""
    worker_id = "worker_1"
    now = get_now_ms()

    # Enqueue a regular priority 5 job into pending
    enqueue("job_normal", priority=5)

    # Enqueue a high-priority delayed job maturing in 50ms
    future_time = get_now_ms() + 50
    enqueue("job_urgent_delayed", priority=9, execute_at=future_time)
    
    # Wait for the scheduled time to pass
    time.sleep(0.08)

    # Promote the delayed job
    promoted = promote_due_delayed_jobs()
    assert promoted >= 1

    # The urgent promoted job should be dequeued BEFORE the normal priority 5 job
    first_job = dequeue(worker_id, visibility_timeout_ms=5000)
    assert first_job == "job_urgent_delayed"

    second_job = dequeue(worker_id, visibility_timeout_ms=5000)
    assert second_job == "job_normal"

def test_atomic_dequeue_leasing():
    """Verify dequeue atomically removes from pending and registers lease in processing queue."""
    worker_id = "worker_lease_test"
    enqueue("job_to_lease", priority=7)

    claimed_id = dequeue(worker_id, visibility_timeout_ms=15000)
    assert claimed_id == "job_to_lease"

    # Confirmed removed from pending
    assert redis_client.zscore("queue:pending", "job_to_lease") is None

    # Confirmed registered in processing queue with future timeout
    lease_score = redis_client.zscore(f"queue:processing:{worker_id}", "job_to_lease")
    assert lease_score is not None
    assert lease_score > get_now_ms() + 10000


def test_lease_renewal_never_resurrects_expired_work():
    from common.queue_engine import renew_lease
    enqueue("long_job")
    dequeue("worker", 30000)
    assert renew_lease("long_job", "worker", 60000)
    assert redis_client.zscore("queue:processing:worker", "long_job") > get_now_ms() + 50000
    redis_client.zadd("queue:processing:worker", {"long_job": get_now_ms() - 1})
    assert not renew_lease("long_job", "worker")
    redis_client.zrem("queue:processing:worker", "long_job")
    assert not renew_lease("long_job", "worker")


def test_cancel_after_promotion_and_after_claim():
    from common.queue_engine import cancel_queued_job
    enqueue("promoted")
    assert cancel_queued_job("promoted")
    assert not dequeue("worker", 1000)
    enqueue("claimed")
    assert dequeue("worker", 1000) == "claimed"
    assert not cancel_queued_job("claimed")
    assert redis_client.zscore("queue:processing:worker", "claimed") is not None


def test_concurrent_workers_claim_each_job_once():
    from concurrent.futures import ThreadPoolExecutor
    for index in range(50):
        enqueue(f"job_{index}")
    with ThreadPoolExecutor(max_workers=8) as pool:
        claims = list(pool.map(lambda index: dequeue(f"worker_{index}", 5000), range(80)))
    claimed = [claim for claim in claims if claim is not None]
    assert len(claimed) == len(set(claimed)) == 50


def test_dead_letter_transition_is_idempotent_and_redrive_is_atomic():
    from common.queue_engine import move_to_dead_letter, redrive_dead_letter
    enqueue("failed", priority=9)
    dequeue("worker", 30000)
    move_to_dead_letter("failed", "worker")
    move_to_dead_letter("failed", "worker")
    assert redis_client.lrange("queue:dead_letter", 0, -1) == ["failed"]
    assert redis_client.hget("jobs:priority", "failed") is None
    redrive_dead_letter("failed", priority=9)
    assert redis_client.llen("queue:dead_letter") == 0
    assert dequeue("other", 30000) == "failed"
