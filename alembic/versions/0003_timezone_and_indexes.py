"""Align migrated schemas with timezone-aware models and query indexes.

Revision ID: 0003
Revises: ea4e3a42e206
"""
from alembic import op
import sqlalchemy as sa

revision = "0003"
down_revision = "ea4e3a42e206"
branch_labels = None
depends_on = None


def upgrade():
    inspector = sa.inspect(op.get_bind())
    for table, names in {
        "jobs": ("created_at", "scheduled_at", "started_at", "completed_at"),
        "worker_heartbeats": ("last_seen",),
    }.items():
        columns = {column["name"]: column for column in inspector.get_columns(table)}
        for name in names:
            if not columns[name]["type"].timezone:
                # Older migrations stored UTC as a timestamp without timezone.
                op.alter_column(table, name, type_=sa.DateTime(timezone=True),
                                postgresql_using=f"{name} AT TIME ZONE 'UTC'")
    for table, column in (("jobs", "status"), ("jobs", "created_at"),
                          ("jobs", "worker_id"), ("worker_heartbeats", "last_seen")):
        op.execute(f"CREATE INDEX IF NOT EXISTS ix_{table}_{column} ON {table} ({column})")


def downgrade():
    # Retain timezone information and indexes to avoid a lossy downgrade.
    pass
