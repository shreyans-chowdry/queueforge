from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field, ConfigDict, field_validator
from sqlalchemy.orm import Session
from typing import Optional, Dict, Any, List
from datetime import datetime, timezone
import uuid

from common.db import get_db
from common.models import Job, JobStatus
from common.queue_engine import enqueue, publish_job_event, redrive_dead_letter, get_dlq_jobs
from common.redis_client import redis_client

router = APIRouter(prefix="/jobs", tags=["jobs"])

class JobCreate(BaseModel):
    payload: Dict[str, Any]
    priority: int = Field(default=5, ge=1, le=10)
    execute_at: Optional[datetime] = None

    @field_validator("payload")
    @classmethod
    def validate_payload(cls, v: Dict[str, Any]) -> Dict[str, Any]:
        if not isinstance(v, dict):
            raise ValueError("Payload must be a dictionary")
        job_type = v.get("type")
        if job_type == "sleep":
            sec = v.get("seconds", 1)
            if not isinstance(sec, (int, float)) or sec < 0 or sec > 300:
                raise ValueError("Sleep seconds must be a number between 0 and 300")
        return v

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
    publish_job_event(str(new_job.id), initial_status.value)
    
    return new_job

@router.get("/dlq", response_model=Dict[str, Any])
def get_dead_letter_queue():
    """
    Returns all job IDs currently in the Dead Letter Queue.
    """
    dlq_ids = get_dlq_jobs(0, 100)
    return {
        "count": len(dlq_ids),
        "job_ids": dlq_ids
    }

@router.get("/{job_id}", response_model=JobResponse)
def get_job(job_id: uuid.UUID, db: Session = Depends(get_db)):
    job = db.query(Job).filter(Job.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job

@router.get("", response_model=List[JobResponse])
def list_jobs(
    status: Optional[JobStatus] = None, 
    limit: int = Query(default=100, ge=1, le=500), 
    db: Session = Depends(get_db)
):
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
        
    redis_client.hdel("jobs:priority", str(job.id))
    job.status = JobStatus.cancelled
    job.error = "Cancelled by user"
    db.commit()
    publish_job_event(str(job.id), JobStatus.cancelled.value)
    
    return {"message": "Job cancelled successfully"}

@router.post("/{job_id}/retry", response_model=JobResponse)
def retry_job(job_id: uuid.UUID, db: Session = Depends(get_db)):
    """
    Re-drives a failed, dead-lettered, or cancelled job back into the active queue.
    """
    job = db.query(Job).filter(Job.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    if job.status not in (JobStatus.dead_letter, JobStatus.failed, JobStatus.cancelled):
        raise HTTPException(
            status_code=400,
            detail=f"Cannot retry job in status: {job.status.value}. Only dead_letter, failed, or cancelled jobs can be retried."
        )

    # Re-drive from DLQ if present, or enqueue to pending
    redrive_dead_letter(str(job.id), priority=job.priority)

    # Reset job state in Postgres
    job.status = JobStatus.pending
    job.attempts = 0
    job.error = None
    job.started_at = None
    job.completed_at = None
    job.worker_id = None
    db.commit()
    db.refresh(job)

    publish_job_event(str(job.id), JobStatus.pending.value)
    return job
