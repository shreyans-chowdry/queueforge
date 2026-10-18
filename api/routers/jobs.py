import logging
import math
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field, ConfigDict, field_validator
from sqlalchemy.orm import Session
from typing import Optional, Dict, Any, List
from datetime import datetime, timezone
import uuid

from common.db import get_db
from common.models import Job, JobStatus
from common.queue_engine import enqueue, publish_job_event, redrive_dead_letter, get_dlq_jobs, cancel_queued_job
from common.redis_client import redis_client
from redis.exceptions import RedisError

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/jobs", tags=["jobs"])


def emit_event(job_id, status):
    # Telemetry is best effort: never report a committed action as failed solely
    # because the Pub/Sub connection dropped. Polling reconciles the dashboard.
    try:
        publish_job_event(job_id, status)
    except RedisError:
        logger.exception("Could not publish job event for %s", job_id)


class JobCreate(BaseModel):
    payload: Dict[str, Any]
    priority: int = Field(default=5, ge=1, le=10)
    execute_at: Optional[datetime] = None

    @field_validator("payload")
    @classmethod
    def validate_payload(cls, v: Dict[str, Any]) -> Dict[str, Any]:
        if not isinstance(v, dict):
            raise ValueError("Payload must be a dictionary")
        def validate_json(value):
            if isinstance(value, float) and not math.isfinite(value):
                raise ValueError("Payload numbers must be finite")
            if isinstance(value, dict):
                for item in value.values():
                    validate_json(item)
            elif isinstance(value, list):
                for item in value:
                    validate_json(item)
        validate_json(v)
        job_type = v.get("type", "sleep")
        if job_type not in ("sleep", "compute", "flaky"):
            raise ValueError("Job type must be sleep, compute, or flaky")
        if job_type == "sleep":
            sec = v.get("seconds", 1)
            if (isinstance(sec, bool) or not isinstance(sec, (int, float))
                    or not 0 <= sec <= 300):
                raise ValueError("Sleep seconds must be a finite number between 0 and 300")
        elif job_type == "compute":
            iterations = v.get("iterations", 500_000)
            if (isinstance(iterations, bool) or not isinstance(iterations, int)
                    or not 1 <= iterations <= 2_000_000):
                raise ValueError("Compute iterations must be an integer between 1 and 2000000")
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
        scheduled_at=exec_time if job_in.execute_at else None,
        status=initial_status
    )
    db.add(new_job)
    db.commit()
    db.refresh(new_job)
    
    # Enqueue in Redis
    try:
        enqueue(str(new_job.id), new_job.priority, execute_at_ms)
    except RedisError:
        # Keep an inspectable, retryable record instead of an invisible stranded job.
        new_job.status = JobStatus.failed
        new_job.error = "Queue unavailable during submission. Retry this job when Redis is healthy."
        db.commit()
        raise HTTPException(status_code=503, detail={"message": new_job.error, "job_id": str(new_job.id)})
    emit_event(str(new_job.id), initial_status.value)
    
    return new_job

@router.get("/dlq", response_model=Dict[str, Any])
def get_dead_letter_queue():
    """
    Returns all job IDs currently in the Dead Letter Queue.
    """
    dlq_ids = get_dlq_jobs(0, 99)
    return {
        "count": redis_client.llen("queue:dead_letter"),
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
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db)
):
    query = db.query(Job)
    if status:
        query = query.filter(Job.status == status)
    jobs = query.order_by(Job.created_at.desc(), Job.id.desc()).offset(offset).limit(limit).all()
    return jobs

@router.post("/{job_id}/cancel")
def cancel_job(job_id: uuid.UUID, db: Session = Depends(get_db)):
    job = db.query(Job).filter(Job.id == job_id).with_for_update().first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
        
    if job.status not in (JobStatus.pending, JobStatus.delayed):
        raise HTTPException(
            status_code=400, 
            detail=f"Cannot cancel job in status: {job.status.value}"
        )
        
    if not cancel_queued_job(str(job.id)):
        raise HTTPException(status_code=409, detail="Job has already been claimed. Refresh its status.")
    job.status = JobStatus.cancelled
    job.error = "Cancelled by user"
    job.completed_at = datetime.now(timezone.utc)
    db.commit()
    emit_event(str(job.id), JobStatus.cancelled.value)
    
    return {"message": "Job cancelled successfully"}

@router.post("/{job_id}/retry", response_model=JobResponse)
def retry_job(job_id: uuid.UUID, db: Session = Depends(get_db)):
    """
    Re-drives a failed, dead-lettered, or cancelled job back into the active queue.
    """
    job = db.query(Job).filter(Job.id == job_id).with_for_update().first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    if job.status not in (JobStatus.dead_letter, JobStatus.failed, JobStatus.cancelled):
        raise HTTPException(
            status_code=400,
            detail=f"Cannot retry job in status: {job.status.value}. Only dead_letter, failed, or cancelled jobs can be retried."
        )

    # Reset job state in Postgres
    job.status = JobStatus.pending
    job.attempts = 0
    job.error = None
    job.started_at = None
    job.completed_at = None
    job.worker_id = None
    job.scheduled_at = None
    job.result = None
    db.commit()
    db.refresh(job)

    try:
        redrive_dead_letter(str(job.id), priority=job.priority)
    except RedisError:
        job.status = JobStatus.failed
        job.error = "Queue unavailable during retry. Try again when Redis is healthy."
        db.commit()
        raise HTTPException(status_code=503, detail=job.error)
    emit_event(str(job.id), JobStatus.pending.value)
    return job
