import time
import json
import random
from typing import Optional, Dict, Any, List
from common.redis_client import redis_client

# Atomic Lua script for dequeue:
# Pops the highest priority job from queue:pending and atomically registers it
# into queue:processing:{worker_id} with visibility lease score.
LUA_DEQUEUE = """
local item = redis.call('ZPOPMIN', KEYS[1], 1)
if item and #item > 0 then
    local job_id = item[1]
    redis.call('ZADD', KEYS[2], ARGV[1], job_id)
    return job_id
end
return nil
"""

# Atomic Lua script for delayed job promotion:
# Checks queue:delayed for mature jobs (score <= now). Atomically removes from
# queue:delayed and adds to queue:pending, retrieving preserved priority from jobs:priority.
# Guarantees that even with scaled workers, exactly one worker promotes each job.
LUA_PROMOTE_DELAYED = """
local due_jobs = redis.call('ZRANGEBYSCORE', KEYS[1], 0, ARGV[1], 'LIMIT', 0, 100)
local promoted = 0
for _, job_id in ipairs(due_jobs) do
    local removed = redis.call('ZREM', KEYS[1], job_id)
    if removed == 1 then
        local prio_str = redis.call('HGET', KEYS[3], job_id)
        local priority = 5
        if prio_str then
            priority = tonumber(prio_str)
        end
        local score = (10 - priority) * 10000000000000 + tonumber(ARGV[1])
        redis.call('ZADD', KEYS[2], score, job_id)
        promoted = promoted + 1
    end
end
return promoted
"""

def get_now_ms() -> int:
    """Returns the current time in milliseconds since the epoch."""
    return int(time.time() * 1000)

def enqueue(job_id: str, priority: int = 5, execute_at: int = None):
    """
    Adds a job to the queue.
    If `execute_at` is in the future, the job goes into 'queue:delayed'.
    Otherwise, it goes into 'queue:pending' with a calculated score that ensures 
    higher priority jobs and earlier enqueued jobs are dequeued first (using ZPOPMIN).
    Score formula: (10 - priority) * 10**13 + enqueued_at_epoch_ms
    """
    now = get_now_ms()
    # Retain priority in hash so delayed promotions & retries preserve original priority
    pipe = redis_client.pipeline()
    pipe.hset("jobs:priority", job_id, priority)
    
    if execute_at and execute_at > now:
        pipe.zadd("queue:delayed", {job_id: execute_at})
    else:
        score = (10 - priority) * (10**13) + now
        pipe.zadd("queue:pending", {job_id: score})
    pipe.execute()


def cancel_queued_job(job_id: str) -> bool:
    """Remove either queued state atomically; a claimed job cannot be cancelled."""
    return bool(redis_client.eval("""
        local removed = redis.call('ZREM', KEYS[1], ARGV[1])
                      + redis.call('ZREM', KEYS[2], ARGV[1])
        if removed > 0 then
            redis.call('HDEL', KEYS[3], ARGV[1])
        end
        return removed
    """, 3, "queue:pending", "queue:delayed", "jobs:priority", job_id))


def renew_lease(job_id: str, worker_id: str, visibility_timeout_ms: int = 30000) -> bool:
    """Extend a live lease only. Expired or recovered jobs cannot be resurrected."""
    now = get_now_ms()
    return bool(redis_client.eval("""
        local expiry = redis.call('ZSCORE', KEYS[1], ARGV[1])
        if expiry and tonumber(expiry) > tonumber(ARGV[2]) then
            redis.call('ZADD', KEYS[1], ARGV[3], ARGV[1])
            return 1
        end
        return 0
    """, 1, f"queue:processing:{worker_id}", job_id, now, now + visibility_timeout_ms))

def promote_due_delayed_jobs() -> int:
    """
    Atomically moves jobs from 'queue:delayed' to 'queue:pending' if their scheduled time has arrived.
    Uses Lua to ensure exactly-once promotion across distributed workers and restores configured priority.
    """
    now = get_now_ms()
    promoted = redis_client.eval(
        LUA_PROMOTE_DELAYED, 
        3, 
        "queue:delayed", 
        "queue:pending", 
        "jobs:priority", 
        now
    )
    return int(promoted or 0)

def dequeue(worker_id: str, visibility_timeout_ms: int) -> Optional[str]:
    """
    Atomically fetches the highest priority job from 'queue:pending' and transfers it
    to 'queue:processing:{worker_id}' with a visibility timeout score.
    Prevents job loss if a worker crashes immediately after claiming.
    """
    now = get_now_ms()
    score = now + visibility_timeout_ms
    job_id = redis_client.eval(
        LUA_DEQUEUE,
        2,
        "queue:pending",
        f"queue:processing:{worker_id}",
        score
    )
    return str(job_id) if job_id else None

def ack(job_id: str, worker_id: str):
    """
    Removes the job from the worker's processing queue and cleans up priority tracking.
    Called when a job completes successfully so it is not processed again or recovered.
    """
    pipe = redis_client.pipeline()
    pipe.zrem(f"queue:processing:{worker_id}", job_id)
    pipe.hdel("jobs:priority", job_id)
    pipe.execute()

def retry_at_ms(attempt: int, base_delay_ms: int = 1000, max_delay_ms: int = 60000) -> int:
    delay = min(max_delay_ms, base_delay_ms * (2 ** min(attempt, 30)))
    jitter = random.randint(0, delay // 2) if delay > 0 else 0
    return get_now_ms() + min(max_delay_ms, delay + jitter)


def requeue_with_backoff(job_id: str, worker_id: str, attempt: int, base_delay_ms: int = 1000, max_delay_ms: int = 60000, execute_at: int = None):
    """
    Removes the job from the processing queue and schedules it for a retry with exponential backoff.
    This limits the rate of retries for failing jobs, allowing transient issues time to resolve.
    """
    if execute_at is None:
        execute_at = retry_at_ms(attempt, base_delay_ms, max_delay_ms)
    pipe = redis_client.pipeline()
    pipe.zrem(f"queue:processing:{worker_id}", job_id)
    pipe.zadd("queue:delayed", {job_id: execute_at})
    pipe.execute()
    return execute_at

def move_to_dead_letter(job_id: str, worker_id: str):
    """
    Removes the job from the processing queue and adds it to the dead letter queue (DLQ).
    Used when a job has exhausted all retries so developers can inspect the persistently failing job later.
    """
    pipe = redis_client.pipeline()
    pipe.zrem(f"queue:processing:{worker_id}", job_id)
    pipe.lrem("queue:dead_letter", 0, job_id)
    pipe.rpush("queue:dead_letter", job_id)
    pipe.hdel("jobs:priority", job_id)
    pipe.execute()

def redrive_dead_letter(job_id: str, priority: int = 5):
    """
    Re-enqueues a job from the dead letter queue back into the active pending queue.
    """
    pipe = redis_client.pipeline()
    pipe.lrem("queue:dead_letter", 0, job_id)
    pipe.zrem("queue:delayed", job_id)
    pipe.hset("jobs:priority", job_id, priority)
    pipe.zadd("queue:pending", {job_id: (10 - priority) * 10**13 + get_now_ms()})
    pipe.execute()

def get_dlq_jobs(start: int = 0, stop: int = -1) -> List[str]:
    """Returns job IDs currently residing in the dead letter queue."""
    return redis_client.lrange("queue:dead_letter", start, stop)

def publish_job_event(
    job_id: str, 
    status: str, 
    worker_id: Optional[str] = None, 
    attempts: Optional[int] = None, 
    error: Optional[str] = None
):
    """
    Publishes a status update for a job to the 'job_events' Redis channel.
    Enriched with worker, attempts, and error details so dashboard clients can
    update state directly without requiring N+1 GET requests.
    """
    message = json.dumps({
        "job_id": job_id, 
        "status": status,
        "worker_id": worker_id,
        "attempts": attempts,
        "error": error,
        "timestamp": get_now_ms()
    })
    redis_client.publish("job_events", message)

def update_worker_registry(worker_id: str, status: str, current_job_id: str = None):
    """
    Updates the worker's heartbeat in the 'workers:registry' hash.
    Used by workers to signal they are alive, and by the reaper to detect dead workers.
    """
    payload = {
        "last_seen": get_now_ms(),
        "status": status,
        "current_job_id": current_job_id
    }
    redis_client.hset("workers:registry", worker_id, json.dumps(payload))

def get_all_workers() -> Dict[str, Any]:
    """
    Retrieves the entire worker registry.
    """
    workers = redis_client.hgetall("workers:registry")
    return {k: json.loads(v) for k, v in workers.items()}
