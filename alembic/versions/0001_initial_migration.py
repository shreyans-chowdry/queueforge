"""initial migration

Revision ID: 0001
Revises: 
Create Date: 2026-08-21 21:38:00.000000

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = '0001'
down_revision = None
branch_labels = None
depends_on = None

def upgrade() -> None:
    # Create ENUM types for postgres
    # JobStatus enum values explanation:
    # pending - Job is waiting in the queue to be picked up
    # delayed - Job is scheduled to run at a future time
    # processing - Job is currently being executed by a worker
    # completed - Job finished executing successfully
    # failed - Job encountered an error but may be retried
    # dead_letter - Job exceeded max retries and will not be attempted again
    job_status = postgresql.ENUM('pending', 'delayed', 'processing', 'completed', 'failed', 'dead_letter', name='jobstatus')

    # WorkerStatus enum values explanation:
    # alive - Worker is actively sending heartbeats
    # dead - Worker missed heartbeats and is considered offline
    worker_status = postgresql.ENUM('alive', 'dead', name='workerstatus')

    op.create_table(
        'jobs',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('payload', sa.JSON(), nullable=False),
        sa.Column('priority', sa.Integer(), nullable=True, server_default='5'),
        sa.Column('status', job_status, nullable=False, server_default='pending'),
        sa.Column('attempts', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('max_retries', sa.Integer(), nullable=False, server_default='3'),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('scheduled_at', sa.DateTime(), nullable=True),
        sa.Column('started_at', sa.DateTime(), nullable=True),
        sa.Column('completed_at', sa.DateTime(), nullable=True),
        sa.Column('worker_id', sa.String(), nullable=True),
        sa.Column('result', sa.JSON(), nullable=True),
        sa.Column('error', sa.Text(), nullable=True),
        sa.PrimaryKeyConstraint('id')
    )

    op.create_table(
        'worker_heartbeats',
        sa.Column('worker_id', sa.String(), nullable=False),
        sa.Column('last_seen', sa.DateTime(), nullable=False),
        sa.Column('status', worker_status, nullable=False, server_default='alive'),
        sa.Column('current_job_id', postgresql.UUID(as_uuid=True), nullable=True),
        sa.PrimaryKeyConstraint('worker_id')
    )

def downgrade() -> None:
    op.drop_table('worker_heartbeats')
    op.drop_table('jobs')
    
    job_status = postgresql.ENUM('pending', 'delayed', 'processing', 'completed', 'failed', 'dead_letter', name='jobstatus')
    job_status.drop(op.get_bind())
    
    worker_status = postgresql.ENUM('alive', 'dead', name='workerstatus')
    worker_status.drop(op.get_bind())
