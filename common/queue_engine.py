import time
import json
import random
from common.redis_client import redis_client

def get_now_ms() -> int:
    """Returns the current time in milliseconds since the epoch."""
    return int(time.time() * 1000)

def enqueue(job_id: str, priority: int, execute_at: int = None):
    """
    Adds a job to the queue.
    If `execute_at` is in the future, the job goes into 'queue:delayed'.
    Otherwise, it goes into 'queue:pending' with a calculated score that ensures 
    higher priority jobs and earlier enqueued jobs are dequeued first (using ZPOPMIN).
    Score formula: (10 - priority) * 10**13 + enqueued_at_epoch_ms
    """
    now = get_now_ms()
    if execute_at and execute_at > now:
        redis_client.zadd("queue:delayed", {job_id: execute_at})
    else:
        score = (10 - priority) * (10**13) + now
        redis_client.zadd("queue:pending", {job_id: score})

def promote_due_delayed_jobs():
    """
    Moves jobs from 'queue:delayed' to 'queue:pending' if their scheduled time has arrived.
    This acts as a scheduler mechanism to activate delayed or retried jobs into the active queue.
    """
    now = get_now_ms()
    # Fetch all jobs whose execution time is <= now
    due_jobs = redis_client.zrangebyscore("queue:delayed", 0, now)
    
    if due_jobs:
        pipe = redis_client.pipeline()
        for job_id in due_jobs:
            pipe.zrem("queue:delayed", job_id)
            # Default priority of 5 is used here since we only have the job_id.
            # In a full system, we might query the DB or store the priority in a hash.
            score = (10 - 5) * (10**13) + now
            pipe.zadd("queue:pending", {job_id: score})
        pipe.execute()

def dequeue(worker_id: str, visibility_timeout_ms: int):
    """
    Fetches the highest priority job (lowest score) from 'queue:pending' using ZPOPMIN.
    Moves it to 'queue:processing:{worker_id}' with a visibility timeout score so that 
    crashed workers can be detected and their jobs recovered.
    """
    result = redis_client.zpopmin("queue:pending")
    if result:
        job_id = result[0][0]
        now = get_now_ms()
        score = now + visibility_timeout_ms
        redis_client.zadd(f"queue:processing:{worker_id}", {job_id: score})
        return job_id
    return None

def ack(job_id: str, worker_id: str):
    """
    Removes the job from the worker's processing queue.
    Called when a job completes successfully so it is not processed again or recovered.
    """
    redis_client.zrem(f"queue:processing:{worker_id}", job_id)

def requeue_with_backoff(job_id: str, worker_id: str, attempt: int, base_delay_ms: int = 1000, max_delay_ms: int = 60000):
    """
    Removes the job from the processing queue and schedules it for a retry with exponential backoff.
    This limits the rate of retries for failing jobs, allowing transient issues time to resolve.
    """
    redis_client.zrem(f"queue:processing:{worker_id}", job_id)
    
    delay = min(max_delay_ms, base_delay_ms * (2 ** attempt))
    jitter = random.randint(0, delay // 2) if delay > 0 else 0
    total_delay = delay + jitter
    
    execute_at = get_now_ms() + total_delay
    redis_client.zadd("queue:delayed", {job_id: execute_at})

def move_to_dead_letter(job_id: str, worker_id: str):
    """
    Removes the job from the processing queue and adds it to the dead letter queue (DLQ).
    Used when a job has exhausted all retries so developers can inspect the persistently failing job later.
    """
    redis_client.zrem(f"queue:processing:{worker_id}", job_id)
    redis_client.rpush("queue:dead_letter", job_id)

def publish_job_event(job_id: str, status: str):
    """
    Publishes a status update for a job to the 'job_events' Redis channel.
    This enables real-time monitoring components to react instantly to job state changes.
    """
    message = json.dumps({"job_id": job_id, "status": status})
    redis_client.publish("job_events", message)
