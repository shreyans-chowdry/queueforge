from fastapi import FastAPI, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import text

from api.routers import jobs
from common.db import get_db
from common.redis_client import redis_client

app = FastAPI(title="QueueForge API")

app.include_router(jobs.router)

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
