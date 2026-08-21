from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, ConfigDict
from sqlalchemy.orm import Session
from typing import Optional, Dict, Any, List
from datetime import datetime, timezone
import uuid

from common.db import get_db
from common.models import Job, JobStatus
from common.queue_engine import enqueue
from common.redis_client import redis_client

router = APIRouter(prefix="/jobs", tags=["jobs"])

class JobCreate(BaseModel):
    payload: Dict[str, Any]
    priority: int = Field(default=5, ge=1, le=10)
    execute_at: Optional[datetime] = None

class JobResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    payload: Dict[str, Any]
    priority: int
    status: JobStatus
    attempts: int
    max_retries: int
    created_at: datetime
    scheduled_at: Optional[datetime]
    started_at: Optional[datetime]
    completed_at: Optional[datetime]
    worker_id: Optional[str]
    result: Optional[Dict[str, Any]]
    error: Optional[str]

@router.post("", response_model=JobResponse, status_code=status.HTTP_201_CREATED)
def create_job(job_in: JobCreate, db: Session = Depends(get_db)):
    # Determine initial status based on execute_at
    is_delayed = False
    execute_at_ms = None
    
    if job_in.execute_at:
        exec_time = job_in.execute_at
        now_time = datetime.now(timezone.utc)
        if exec_time.tzinfo is None:
            exec_time = exec_time.replace(tzinfo=timezone.utc)
        if exec_time > now_time:
            is_delayed = True
        execute_at_ms = int(exec_time.timestamp() * 1000)
    
    initial_status = JobStatus.delayed if is_delayed else JobStatus.pending
    
    # Create Job in Postgres
    new_job = Job(
        payload=job_in.payload,
        priority=job_in.priority,
        scheduled_at=job_in.execute_at,
        status=initial_status
    )
    db.add(new_job)
    db.commit()
    db.refresh(new_job)
    
    # Enqueue in Redis
    enqueue(str(new_job.id), new_job.priority, execute_at_ms)
    
    return new_job

@router.get("/{job_id}", response_model=JobResponse)
def get_job(job_id: uuid.UUID, db: Session = Depends(get_db)):
    job = db.query(Job).filter(Job.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job

@router.get("", response_model=List[JobResponse])
def list_jobs(status: Optional[JobStatus] = None, limit: int = 100, db: Session = Depends(get_db)):
    query = db.query(Job)
    if status:
        query = query.filter(Job.status == status)
    jobs = query.order_by(Job.created_at.desc()).limit(limit).all()
    return jobs

@router.post("/{job_id}/cancel")
def cancel_job(job_id: uuid.UUID, db: Session = Depends(get_db)):
    job = db.query(Job).filter(Job.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
        
    if job.status not in (JobStatus.pending, JobStatus.delayed):
        raise HTTPException(
            status_code=400, 
            detail=f"Cannot cancel job in status: {job.status.value}"
        )
        
    # Remove from Redis
    if job.status == JobStatus.pending:
        redis_client.zrem("queue:pending", str(job.id))
    elif job.status == JobStatus.delayed:
        redis_client.zrem("queue:delayed", str(job.id))
        
    job.status = JobStatus.cancelled
    job.error = "Cancelled by user"
    db.commit()
    
    return {"message": "Job cancelled successfully"}
