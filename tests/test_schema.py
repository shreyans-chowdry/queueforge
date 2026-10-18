from sqlalchemy import inspect, text

from common.db import engine
from common.schema import upgrade_schema


def test_adopts_legacy_schema_and_runs_migrations_idempotently():
    # conftest creates the same unversioned schema as the original API.
    upgrade_schema()
    upgrade_schema()
    with engine.connect() as connection:
        assert connection.execute(text("SELECT version_num FROM alembic_version")).scalar() == "0003"
        columns = inspect(connection).get_columns("jobs")
        assert next(column for column in columns if column["name"] == "created_at")["type"].timezone
