"""Apply migrations once, including databases bootstrapped by older releases."""
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import inspect, text

from common.db import engine


def upgrade_schema():
    root = Path(__file__).resolve().parent.parent
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "alembic"))
    with engine.begin() as connection:
        # Serialize startup across multiple API instances.
        connection.execute(text("SELECT pg_advisory_xact_lock(724193821)"))
        config.attributes["connection"] = connection
        tables = inspect(connection).get_table_names()
        if "jobs" in tables and "alembic_version" not in tables:
            # Previous API releases used create_all without Alembic tracking.
            command.stamp(config, "0001")
        command.upgrade(config, "head")
