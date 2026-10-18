# QueueForge Architecture & Technical Deep Dive

This document provides a comprehensive technical breakdown of QueueForge's internal mechanics, atomic Redis data structures, memory layout, and the end-to-end lifecycle of a background job.

---

## 1. Redis Data Structures & Memory Layout

QueueForge relies exclusively on native Redis Sorted Sets (`ZSET`), Hashes (`HASH`), Lists (`LIST`), and Pub/Sub channels to coordinate distributed state without external queue frameworks.

| Key | Type | Member / Field | Score / Value | Description |
|---|---|---|---|---|
| `queue:pending` | **ZSET** | `job_id` (UUID string) | `(10 - priority) * 10^13 + enqueued_at_ms` | Jobs ready for immediate dequeue. Smallest score sorts first. |
| `queue:delayed` | **ZSET** | `job_id` (UUID string) | `execute_at_epoch_ms` | Jobs scheduled for future execution. Promoted when `score <= now`. |
| `queue:processing:{worker_id}` | **ZSET** | `job_id` (UUID string) | `now + visibility_timeout_ms` | Active lease held by a worker. Expired score signifies crash. |
| `queue:dead_letter` | **LIST** | `job_id` (UUID string) | — | Unrecoverable jobs that exhausted `max_retries`. |
| `workers:registry` | **HASH** | `worker_id` | JSON `{last_seen, status, current_job_id}` | Real-time cluster worker heartbeat registry. |
| `job_events` | **Pub/Sub** | — | JSON payload `{"job_id": ..., "status": ...}` | Event stream bridging worker state to API WebSocket clients. |

---

### Score Calculation Mathematics

#### 1. Pending Queue Score
```
score = (10 - priority) * 10^13 + enqueued_at_epoch_ms
```
- **Priority Range:** Integer between `1` (lowest) and `10` (highest).
- **Weighting:** Multiplier `10^13` ensures that priority always dominates timestamps (since epoch milliseconds occupy ~13 digits: `1.7e12`).
- **Tiebreaking:** Two jobs with equal priority are naturally sorted by `enqueued_at_epoch_ms` ascending, preserving enqueue-time ordering within the same priority tier. Jobs with equal millisecond scores are ordered lexicographically by ID.

#### 2. Delayed Queue Score
```
score = execute_at_epoch_ms
```
- Workers execute a Lua script that finds up to 100 due jobs with `ZRANGEBYSCORE`, removes them, and inserts them into `queue:pending` while preserving priority.

---

## 2. Complete End-to-End Job Lifecycle

```
             ┌─────────────────────────┐
             │       POST /jobs        │
             └────────────┬────────────┘
                          │
                   execute_at set?
                    /           \
                 (Yes)          (No)
                  /               \
        ┌────────▼───────┐   ┌────▼───────────┐
        │ queue:delayed  │   │ queue:pending  │
        └────────┬───────┘   └────┬───────────┘
                 │ (Promote)      │
                 └───────────────►│
                                  │
                          ┌───────▼────────┐
                          │    dequeue()   │ ◄─── Atomic ZPOPMIN + ZADD
                          └───────┬────────┘
                                  │
                     ┌────────────▼──────────────┐
                     │ queue:processing:{worker} │
                     └────────────┬──────────────┘
                                  │
                            Execute Job
                           /           \
                     (Success)       (Failure)
                       /                   \
            ┌─────────▼────────┐      attempts < max?
            │ status=completed │       /           \
            │ ZREM processing  │     (Yes)         (No)
            └──────────────────┘     /               \
                   ┌────────────────▼─────┐   ┌───────▼───────────┐
                   │  Retry with Backoff  │   │ status=dead_letter│
                   │  status=delayed      │   │ RPUSH dead_letter │
                   │  ZADD queue:delayed  │   └───────────────────┘
                   └──────────────────────┘
```

### Stage 1: Ingestion (`POST /jobs`)
1. Client submits `{ payload, priority, execute_at }` to FastAPI.
2. Pydantic validates boundaries (`1 <= priority <= 10`).
3. An ACID transaction writes a new row to PostgreSQL (`status="pending"` or `"delayed"`).
4. `enqueue(job_id, priority, execute_at)` places the job ID into either `queue:pending` or `queue:delayed`.

### Stage 2: Delayed Job Promotion
1. At the beginning of each polling cycle, workers invoke `promote_due_delayed_jobs()`.
2. Uses `ZRANGEBYSCORE queue:delayed 0 <now_ms>` to discover jobs whose schedule has matured.
3. Inside a single atomic Lua script, due jobs are removed from `queue:delayed` and pushed to `queue:pending`.

### Stage 3: Atomic Dequeue & Visibility Lease
1. Worker calls `dequeue(worker_id, visibility_timeout_ms=30000)`.
2. Atomically claims the highest priority item via `ZPOPMIN queue:pending 1`.
3. Simultaneously registers an active lease in `queue:processing:{worker_id}` with score `now + visibility_timeout_ms`.
4. PostgreSQL status is updated to `"processing"` with `started_at` timestamp.
5. A heartbeat renews live leases every 5 seconds; an expired lease cannot be revived. No database transaction is held during handler execution.
6. Worker updates `workers:registry` with `current_job_id` and broadcasts `{job_id, status: "processing"}` to `job_events`.

### Stage 4: Execution & Handlers
Built-in execution handlers execute according to `payload["type"]`:
- **`sleep`**: Simulates I/O wait (`time.sleep(payload["seconds"])`).
- **`compute`**: Simulates CPU-bound hashing workload.
- **`flaky`**: Simulates transient network/dependency failures (~30% failure rate).

### Stage 5: Completion or Exponential Retry
- **On Success:**
  - Status marked `"completed"` in PostgreSQL.
  - Job removed from `queue:processing:{worker_id}`.
  - Broadcast `{job_id, status: "completed"}`.
- **On Failure:**
  - Increments `attempts`.
  - If `attempts < max_retries`:
    - Backoff formula: `delay_seconds = 2 ** attempts`.
    - Status set to `"delayed"` with scheduled retry timestamp.
    - Added to `queue:delayed` for backoff duration.
  - If `attempts >= max_retries`:
    - Status set to `"dead_letter"`.
    - Job ID appended to `queue:dead_letter` list.
    - Error message recorded in PostgreSQL `error` column.

### Stage 6: Fault Recovery via The Reaper Daemon
The **Reaper** runs continuously on a background interval (every 10 seconds):
1. **Orphaned Job Recovery (`reap_orphaned_jobs`)**:
   - Uses non-blocking SCAN to inspect processing keys (`queue:processing:*`).
   - Discovers leases where `score < now` (worker crashed or froze mid-task).
   - Locks the PostgreSQL row and rechecks expiry. A lost execution increments failures and moves the job to delayed retry or DLQ. Committed outcomes are reconciled without executing completed jobs again.
2. **Dead Worker Cleanup (`cleanup_dead_workers`)**:
   - Inspects `workers:registry`.
   - Any worker whose heartbeat `last_seen > 15s` is marked `status="dead"`.

### Stage 7: Telemetry & Live Ops Console Stream
1. Any state transition triggers `publish_job_event(job_id, status)` over Redis channel `job_events`.
2. The FastAPI API process runs a persistent `pubsub_listener` task via its `lifespan` manager.
3. The listener consumes Redis messages and pushes them to connected WebSockets (`/ws/jobs`) using `ConnectionManager.broadcast()`.
4. The Next.js console batches notifications into bounded snapshots of the latest 150 jobs. A 5-second poll and reconnect refresh repair missed events; Pub/Sub is not durable. Failed refreshes preserve the last successful snapshot and show an error.


## Concurrency and delivery boundaries

Cancellation removes pending and delayed membership in one Lua operation, so a job
that has already been claimed returns a conflict instead of falsely appearing cancelled.
Workers, retries, and the reaper acquire a PostgreSQL row lock before inspecting job
state. Workers verify a live lease and matching assignment again before recording results.
Retries and dead-letter transitions move queue membership atomically inside Redis.

The two stores do not share a transaction. Persisting outcomes before queue transitions
allows the reaper to repair interrupted acknowledgements and retries. Ingestion and
user-action crash gaps still require an outbox for guaranteed dispatch. Handlers must
be idempotent: lease fencing protects recorded state, not external side effects from
an already running stale executor. See the README for operational limits and tests.
