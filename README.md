# QueueForge
QueueForge is a distributed background job processing system with priority queues, delayed execution, retries, and real-time monitoring.

## Setup Instructions

1. **Configure Environment:**
   ```bash
   cp .env.example .env
   ```

2. **Start Infrastructure (Docker):**
   ```bash
   docker compose up -d
   ```
   > **Note:** The PostgreSQL database is mapped to port **5433** on the host, and Redis is mapped to port **6380** to avoid conflicts with native instances running on macOS. Ensure your `.env` connection URLs point to `127.0.0.1:5433` and `127.0.0.1:6380` respectively.

3. **Run Migrations:**
   Ensure you have a Python virtual environment set up, dependencies installed, and then run:
   ```bash
   alembic upgrade head
   ```
