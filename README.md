# QueueForge ⚡

A high-throughput, distributed background job processing system built from scratch using **Redis primitives (Sorted Sets, Hashes, Pub/Sub)** and **PostgreSQL**, accompanied by a live **Next.js mission-control ops console**.

Think of **QueueForge** like an airport air-traffic control and triage system: when high-priority emergency landings arrive, they leapfrog routine flights immediately; scheduled arrivals wait on holding patterns until their exact slot time; if a runway ground crew suddenly disappears mid-service, a supervisor detects the timeout and safely re-routes the plane to another crew without losing luggage or duplicating flight logs.

---

## 🏛️ Architecture Overview

```
                          ┌────────────────────────┐
                          │    Next.js Console     │
                          │   (localhost:3000)     │
                          └───────────▲────────────┘
                                      │ WebSocket / HTTP
                                      │
                          ┌───────────┴────────────┐
                          │      FastAPI API       │
                          │   (localhost:8000)     │
                          └──────┬──────────┬──────┘
                                 │          │
                     Enqueue /   │          │ Read/Write
                     PubSub Sub  │          │ Metadata
                                 │          │
            ┌────────────────────▼──┐    ┌──▼────────────────────┐
            │     Redis Engine      │    │  PostgreSQL Storage   │
            │  - queue:pending (ZSET│    │  - jobs               │
            │  - queue:delayed (ZSET│    │  - worker_heartbeats  │
            │  - queue:processing:* │    └───────────────────────┘
            │  - queue:dead_letter  │                ▲
            │  - workers:registry   │                │
            └───────────▲───────────┘                │
                        │ Dequeue / Heartbeat        │ Status Updates
                        │                            │
         ┌──────────────┴──────────────┐             │
         │                             │             │
┌────────┴─────────┐         ┌─────────┴────────┐    │
│  Worker Cluster  │         │  Reaper Daemon   │────┘
│  (3x Replicas)   │         │   (Crash Recv)   │
└──────────────────┘         └──────────────────┘
```

---

## 🚀 Quickstart

### Prerequisites
- [Docker](https://docs.docker.com/get-docker/) and [Docker Compose](https://docs.docker.com/compose/) installed.

### Setup & Run
1. **Clone the repository:**
   ```bash
   git clone https://github.com/shreyans-chowdry/queueforge.git
   cd queueforge
   ```

2. **Configure Environment:**
   ```bash
   cp .env.example .env
   ```

3. **Launch the Full Distributed Stack (with 3 concurrent workers):**
   ```bash
   docker compose up --build --scale worker=3
   ```

4. **Access Endpoints:**
   - 🖥️ **Ops Console Dashboard**: [http://localhost:3000](http://localhost:3000)
   - 📖 **FastAPI Swagger API Docs**: [http://localhost:8000/docs](http://localhost:8000/docs)
   - 🔌 **Live WebSocket Stream**: `ws://localhost:8000/ws/jobs`

---

## 💡 Key Design Decisions

- **Unified Redis Sorted Sets for Priority AND Delayed Queues:**
  Rather than running separate broker queues, both prioritized execution and scheduled delays use Redis Sorted Sets (`ZSET`). For pending tasks, scores are computed using `(10 - priority) * 10^13 + enqueued_at_epoch_ms`, sorting higher-priority tasks first, then ordering equal priorities by enqueue millisecond (equal scores use Redis member ordering). Delayed tasks store `execute_at_epoch_ms` as their score; workers atomically promote due jobs with a Lua script using `ZRANGEBYSCORE`.
- **Built from Scratch vs. Off-the-Shelf (e.g., Celery):**
  Celery and other framework abstractions obscure crucial distributed systems realities: broker-level atomic guarantees, Lua scripting semantics, visibility lease renewal, and exact worker failure recovery. Building QueueForge natively with atomic Redis primitives (`ZPOPMIN`, `HSET`, `ZREM`) gives complete transparency into concurrency, backoff mathematics, and queue mechanics.
- **Dual-Storage: Redis alongside PostgreSQL:**
  Redis serves as the low-latency in-memory coordination engine (millisecond priority ordering, atomic pops, ephemeral heartbeats, Pub/Sub event stream). PostgreSQL provides an ACID-compliant durable historical audit trail, structured state persistence, complex analytical querying, and long-term reporting even if Redis memory is flushed.
- **Crash Resilience via Visibility Timeouts & The Reaper:**
  When a worker claims a job via `dequeue()`, the job ID is atomically moved into `queue:processing:{worker_id}` with a score equal to `now + visibility_timeout_ms` (lease expiry). If a worker process abruptly segfaults, gets killed with `SIGKILL`, or loses network connection, the separate **Reaper Daemon** detects expired leases and stale heartbeats (`workers:registry`), re-enqueuing abandoned jobs and tagging the dead worker.

---

## 📊 Benchmark & Load Test Results

QueueForge includes an automated asynchronous benchmarking suite (`scripts/load_test.py`) that simulates 500 heterogeneous jobs under high concurrency:

```
================================================================================
                    QUEUEFORGE LOAD TEST EXECUTION REPORT
================================================================================
Timestamp:               2026-08-22 02:18:34
Target Endpoint:         http://127.0.0.1:8000
Concurrency Limit:       40 workers
Timeout Window:          180s

--------------------------------------------------------------------------------
1. WORKLOAD SUMMARY
--------------------------------------------------------------------------------
Total Jobs Requested:    500
Successfully Enqueued:   500 (100.0%)
Delayed Jobs Ratio:      ~20% (scheduled with future execute_at)
Failure Simulation:      Flaky job type (~30% transient exception rate)

--------------------------------------------------------------------------------
2. EXECUTION OUTCOMES
--------------------------------------------------------------------------------
Completed Successfully:  496 (99.2%)
Dead-Letter / Failed:    4 (0.8%)
Other / Unfinished:      0

--------------------------------------------------------------------------------
3. PERFORMANCE & LATENCY
--------------------------------------------------------------------------------
Ingestion Time:          1.22s (410.6 jobs/s)
Total Wall-Clock Time:   48.78s
System Throughput:       10.17 completed jobs/sec
Average Job Latency:     19.466s (created_at -> completed_at)

--------------------------------------------------------------------------------
4. RETRY & DEAD-LETTER VALIDATION
--------------------------------------------------------------------------------
Dead-Letter Queue Check: Verified 4 jobs exhausted max_retries
Backoff & Re-queue:      Successfully exercised exponential backoff
Status:                  PASSED
================================================================================
```

---

## 🔮 What I'd Improve With More Time

1. **Distributed Tracing (OpenTelemetry)**:
   Propagate `traceparent` context IDs across HTTP ingestion, Redis job payloads, worker execution logs, and database rows to provide end-to-end distributed flamegraphs.
2. **Partitioned Ingestion via Kafka/Pulsar for 100k+ msg/sec**:
   At massive scale, Redis single-threaded sorted sets can bottleneck on ingestion locks. Fronting the queue with partitioned append-only logs allows horizontal sharding across independent worker shards.
3. **Durable Dispatch & Idempotent Handlers**:
   Add a PostgreSQL outbox and reconciliation for the database-to-Redis dispatch gap. Use idempotency keys inside handlers to deduplicate side effects across retries; queue-level deduplication alone cannot guarantee exactly-once execution.
4. **Dynamic Autoscaling**:
   Implement dynamic worker scaling based on queue depth metrics (`queue:pending` cardinality / worker count) using the Kubernetes Horizontal Pod Autoscaler (HPA).

---

## 📚 Deep Dive Documentation

For a detailed walkthrough of the Redis data structures, memory layout, and the full step-by-step job lifecycle state machine, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).


## Development and verification

Python 3.12 and Node.js 22 are used in CI. Install backend dependencies with
`pip install -r requirements.txt` and dashboard dependencies with `cd dashboard && npm ci`.
The API applies Alembic migrations at startup under a PostgreSQL advisory lock.
Existing databases created by older API releases are adopted automatically; UTC
columns and missing query indexes are migrated without dropping job history.
Workers and the reaper wait for API readiness in Compose. Redis uses append-only persistence.

Integration tests require a database whose name ends in `_test` and an **empty,
dedicated non-default Redis database**. Tests refuse application `.env` targets,
create a temporary PostgreSQL schema, and clear only the explicitly supplied test Redis database.
Do not point these variables at a shared application database or active workers.

```bash
TEST_DATABASE_URL=postgresql://queueforge_user:queueforge_pass@localhost:5433/queueforge_test \
TEST_REDIS_URL=redis://localhost:6380/15 python -m pytest -q

cd dashboard
npm run lint
npx tsc --noEmit
npm audit --omit=dev --audit-level=high
npm run build
npx playwright install chromium
npm run test:e2e
```

Create `queueforge_test` separately before running tests. Browser tests exercise the
production build using mocked API responses, including submission, error feedback,
job inspection, timestamp offsets, keyboard focus, and a mobile viewport.

## Operational behavior and limits

- A worker renews its live 30-second lease every 5 seconds, including during long jobs.
  Expired leases cannot be renewed. PostgreSQL row locks serialize recovery and
  user actions; stale executors cannot overwrite a recovered job's recorded outcome.
- Cancelling a job atomically removes it from either queued state, including after
  delayed promotion. Already claimed jobs return HTTP 409. Retries reset scheduling,
  errors, results, assignment, and the retry budget.
- Invalid task types and unbounded or non-finite workload parameters return HTTP 422.
  If enqueueing fails, the API returns HTTP 503 with an inspectable failed job that can
  be retried. Pub/Sub failures do not turn successful API actions into failures.
- The console displays the **latest 150 jobs**, with explicitly scoped metrics. It
  batches stream updates, refreshes every 5 seconds, and reconciles on reconnect.
  Click a job ID to inspect its payload, error, lifecycle times, and result.
- Delivery is **at least once**, subject to retry limits. Handlers must make external
  side effects idempotent. PostgreSQL commits and Redis writes are separate operations;
  a process crash in the ingestion/cancellation/retry gap still needs a durable outbox
  to guarantee dispatch recovery. Redis AOF reduces broker loss but does not close that gap.
- The included deployment is a local demonstration without authentication or tenant
  isolation. Configure dashboard URLs and CORS for your environment before deploying.
- Next.js and React are updated to patched releases. Production `npm audit --omit=dev`
  is clean. The full audit currently reports five high-severity development-only
  findings through `eslint-config-next` → `fast-glob` → `micromatch` → `braces`;
  npm offers no compatible patched release. CI gates production dependencies.
