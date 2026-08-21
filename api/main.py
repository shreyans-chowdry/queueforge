from fastapi import FastAPI, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import text

from api.routers import jobs
from api.websocket import router as ws_router, pubsub_listener
from common.db import get_db
from common.redis_client import redis_client
from contextlib import asynccontextmanager
import asyncio

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: Start listening to Redis Pub/Sub for job events
    listener_task = asyncio.create_task(pubsub_listener())
    yield
    # Shutdown: Cancel the listener task gracefully
    listener_task.cancel()
    try:
        await listener_task
    except asyncio.CancelledError:
        pass

app = FastAPI(title="QueueForge API", lifespan=lifespan)

app.include_router(jobs.router)
app.include_router(ws_router)

@app.get("/health")
def health_check(db: Session = Depends(get_db)):
    """
    Checks connectivity to both PostgreSQL and Redis.
    Returns 200 OK if both are healthy, 503 Service Unavailable otherwise.
    """
    try:
        # Check Postgres
        db.execute(text("SELECT 1"))
        
        # Check Redis
        redis_client.ping()
    except Exception as e:
        raise HTTPException(
            status_code=503, 
            detail=f"Service unavailable: {str(e)}"
        )
        
    return {"status": "ok", "postgres": "connected", "redis": "connected"}
