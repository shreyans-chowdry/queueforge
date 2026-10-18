"""Integration tests use an explicit test DB, isolated schema and empty test Redis.

Never load application .env values as test targets. Redis must be a dedicated,
non-default database: tests clear it between cases.
"""
import os
import uuid
from urllib.parse import urlparse

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url


database_url = os.environ.get("TEST_DATABASE_URL")
redis_url = os.environ.get("TEST_REDIS_URL")
if not database_url or not redis_url:
    raise pytest.UsageError("Set TEST_DATABASE_URL (database name ending in _test) and TEST_REDIS_URL (dedicated empty database, e.g. /15). See README.md.")
if not make_url(database_url).database.endswith("_test"):
    raise pytest.UsageError("TEST_DATABASE_URL must name a database ending in _test")
database_url = database_url.replace("postgresql://", "postgresql+psycopg2://", 1)
if urlparse(redis_url).path in ("", "/", "/0"):
    raise pytest.UsageError("TEST_REDIS_URL must use a dedicated non-default Redis database")

schema = f"test_{uuid.uuid4().hex}"
os.environ["DATABASE_URL"] = make_url(database_url).update_query_dict({"options": f"-csearch_path={schema}"}).render_as_string(hide_password=False)
os.environ["REDIS_URL"] = redis_url

from common.db import engine, SessionLocal  # noqa: E402
from common.models import Base, Job  # noqa: E402
from common.redis_client import redis_client  # noqa: E402


@pytest.fixture(scope="session", autouse=True)
def isolated_services():
    if redis_client.dbsize():
        raise pytest.UsageError("Refusing to clear a non-empty TEST_REDIS_URL. Supply an empty dedicated Redis database.")
    admin = create_engine(database_url)
    with admin.begin() as conn:
        conn.execute(text(f'CREATE SCHEMA "{schema}"'))
    Base.metadata.create_all(engine)
    yield
    redis_client.flushdb()
    engine.dispose()
    with admin.begin() as conn:
        conn.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
    admin.dispose()


@pytest.fixture(autouse=True)
def clean_state(isolated_services):
    redis_client.flushdb()
    with SessionLocal() as db:
        db.query(Job).delete()
        db.commit()
    yield


@pytest.fixture
def anyio_backend():
    return "asyncio"
