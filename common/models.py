import enum
import uuid
from datetime import datetime
from sqlalchemy import Column, String, Integer, DateTime, Enum, JSON, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import declarative_base

Base = declarative_base()

class JobStatus(enum.Enum):
    pending = "pending"          # Job is waiting in the queue to be picked up
    delayed = "delayed"          # Job is scheduled to run at a future time
    processing = "processing"    # Job is currently being executed by a worker
    completed = "completed"      # Job finished executing successfully
    failed = "failed"            # Job encountered an error but may be retried
    dead_letter = "dead_letter"  # Job exceeded max retries and will not be attempted again

class WorkerStatus(enum.Enum):
    alive = "alive"  # Worker is actively sending heartbeats
    dead = "dead"    # Worker missed heartbeats and is considered offline

class Job(Base):
    __tablename__ = "jobs"
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    payload = Column(JSON, nullable=False)
    priority = Column(Integer, default=5) # 1-10
    status = Column(Enum(JobStatus), default=JobStatus.pending, nullable=False)
    attempts = Column(Integer, default=0, nullable=False)
    max_retries = Column(Integer, default=3, nullable=False)
    
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    scheduled_at = Column(DateTime, nullable=True)
    started_at = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, nullable=True)
    
    worker_id = Column(String, nullable=True)
    result = Column(JSON, nullable=True)
    error = Column(Text, nullable=True)

class WorkerHeartbeat(Base):
    __tablename__ = "worker_heartbeats"
    
    worker_id = Column(String, primary_key=True)
    last_seen = Column(DateTime, default=datetime.utcnow, nullable=False)
    status = Column(Enum(WorkerStatus), default=WorkerStatus.alive, nullable=False)
    current_job_id = Column(UUID(as_uuid=True), nullable=True)
