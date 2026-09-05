#!/usr/bin/env python3
"""
QueueForge 1,000 Job Burst Benchmark
Blasts 1,000 heterogeneous tasks concurrently into QueueForge API.
"""

import asyncio
import httpx
import random
import time
from datetime import datetime, timedelta, timezone

API_BASE = "http://127.0.0.1:8000"
TOTAL_JOBS = 1000
CONCURRENCY = 50

async def submit_job(client: httpx.AsyncClient, semaphore: asyncio.Semaphore, idx: int):
    async with semaphore:
        # Realistic workload distribution
        # 50% compute (fast CPU), 30% sleep (light I/O), 10% flaky (retry testing), 10% delayed
        roll = random.random()
        
        execute_at = None
        if roll < 0.10:
            # Delayed task (scheduled 2 to 5 seconds in future)
            delay_sec = random.uniform(2.0, 5.0)
            execute_at = (datetime.now(timezone.utc) + timedelta(seconds=delay_sec)).isoformat()
            payload = {"type": "compute", "iterations": 50000}
            priority = random.choice([7, 8, 9])
        elif roll < 0.20:
            # Flaky task (transient failure testing)
            payload = {"type": "flaky"}
            priority = random.randint(3, 7)
        elif roll < 0.50:
            # Sleep task (light I/O: 0.02s - 0.08s)
            payload = {"type": "sleep", "seconds": round(random.uniform(0.02, 0.08), 3)}
            priority = random.randint(1, 6)
        else:
            # Compute task (SHA-256 hashing)
            payload = {"type": "compute", "iterations": random.randint(10000, 80000)}
            # 15% chance of urgent priority 10
            priority = 10 if random.random() < 0.15 else random.randint(4, 9)

        body = {
            "payload": payload,
            "priority": priority,
            "execute_at": execute_at
        }

        try:
            resp = await client.post(f"{API_BASE}/jobs", json=body, timeout=10.0)
            if resp.status_code in (200, 201):
                return True
            else:
                print(f"[!] Job {idx} HTTP {resp.status_code}: {resp.text}")
                return False
        except Exception as e:
            print(f"[!] Job {idx} error: {e}")
            return False

async def main():
    print("=" * 65)
    print(f"🚀 INGESTING 1,000 JOBS BURST -> {API_BASE}")
    print(f"⚡ Ingestion Concurrency: {CONCURRENCY}")
    print("=" * 65)

    start_time = time.time()
    semaphore = asyncio.Semaphore(CONCURRENCY)

    # Use HTTP/1.1 keep-alive pool with httpx
    limits = httpx.Limits(max_keepalive_connections=CONCURRENCY, max_connections=CONCURRENCY)
    async with httpx.AsyncClient(limits=limits) as client:
        tasks = [submit_job(client, semaphore, i) for i in range(TOTAL_JOBS)]
        results = await asyncio.gather(*tasks)

    duration = time.time() - start_time
    successful = sum(1 for r in results if r)
    rate = successful / duration if duration > 0 else 0

    print("\n" + "=" * 65)
    print(f"✓ Successfully dispatched: {successful}/{TOTAL_JOBS} jobs")
    print(f"⏱️ Total Ingestion Time:   {duration:.2f} seconds")
    print(f"⚡ Ingestion Velocity:      {rate:.1f} jobs/second")
    print("=" * 65)

if __name__ == "__main__":
    asyncio.run(main())
