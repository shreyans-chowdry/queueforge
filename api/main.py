import os
import asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI, Depends, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from sqlalchemy import text

from api.routers import jobs, workers
from api.websocket import router as ws_router, pubsub_listener
from common.db import get_db
from common.schema import upgrade_schema
from common.redis_client import redis_client

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Ensure database tables exist
    await asyncio.to_thread(upgrade_schema)
    
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


@app.exception_handler(RequestValidationError)
async def validation_error(_request: Request, exc: RequestValidationError):
    # Echoing an invalid NaN/Infinity input would itself fail JSON encoding,
    # turning a validation error into HTTP 500. Return structured errors only.
    return JSONResponse(status_code=422, content={
        "detail": [{"loc": list(error["loc"]), "msg": error["msg"], "type": error["type"]}
                   for error in exc.errors()]
    })

# Allow CORS for configured dashboard origins
allowed_origins_env = os.getenv("CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000")
allowed_origins = [origin.strip() for origin in allowed_origins_env.split(",") if origin.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(jobs.router)
app.include_router(ws_router)
app.include_router(workers.router)

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
    except Exception:
        raise HTTPException(
            status_code=503, 
            detail="Database or queue unavailable"
        )
        
    return {"status": "ok", "postgres": "connected", "redis": "connected"}
