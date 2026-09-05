import pytest
import httpx
import uuid
from datetime import datetime, timedelta, timezone

from api.main import app
from common.redis_client import redis_client

@pytest.fixture
async def client():
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c

@pytest.mark.anyio
async def test_submit_valid_job(client):
    """Submitting a valid job returns 201/200 with a valid job id."""
    response = await client.post(
        "/jobs",
        json={"payload": {"type": "sleep", "seconds": 1}, "priority": 5}
    )
    assert response.status_code in (200, 201)
    data = response.json()
    assert "id" in data
    # Verify UUID format
    parsed_uuid = uuid.UUID(data["id"])
    assert str(parsed_uuid) == data["id"]
    assert data["priority"] == 5
    assert data["status"] in ("pending", "processing", "completed")

@pytest.mark.anyio
async def test_submit_invalid_priority(client):
    """Submitting an invalid priority (e.g. 15 or 0) returns 422 validation error."""
    # Test priority > 10
    response_high = await client.post(
        "/jobs",
        json={"payload": {"type": "sleep", "seconds": 1}, "priority": 15}
    )
    assert response_high.status_code == 422

    # Test priority < 1
    response_low = await client.post(
        "/jobs",
        json={"payload": {"type": "sleep", "seconds": 1}, "priority": 0}
    )
    assert response_low.status_code == 422

@pytest.mark.anyio
async def test_get_nonexistent_job(client):
    """Fetching a nonexistent job id returns 404."""
    non_existent_id = str(uuid.uuid4())
    response = await client.get(f"/jobs/{non_existent_id}")
    assert response.status_code == 404
    assert response.json().get("detail") == "Job not found"

@pytest.mark.anyio
async def test_cancel_pending_or_delayed_job(client):
    """Cancelling a pending/delayed job changes its status in Postgres AND removes it from Redis."""
    # 1. Test delayed job cancellation
    future_time = (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat()
    create_delayed_resp = await client.post(
        "/jobs",
        json={
            "payload": {"type": "sleep", "seconds": 5},
            "priority": 3,
            "execute_at": future_time
        }
    )
    assert create_delayed_resp.status_code in (200, 201)
    delayed_job_id = create_delayed_resp.json()["id"]
    assert create_delayed_resp.json()["status"] == "delayed"

    # Verify present in Redis delayed queue before cancellation
    assert redis_client.zscore("queue:delayed", str(delayed_job_id)) is not None

    # Cancel the delayed job
    cancel_delayed_resp = await client.post(f"/jobs/{delayed_job_id}/cancel")
    assert cancel_delayed_resp.status_code == 200

    # Assert Postgres status is cancelled
    get_delayed_resp = await client.get(f"/jobs/{delayed_job_id}")
    assert get_delayed_resp.status_code == 200
    assert get_delayed_resp.json()["status"] == "cancelled"

    # CRITICAL: Assert removed from Redis sorted set
    assert redis_client.zscore("queue:delayed", str(delayed_job_id)) is None

    # 2. Test pending job cancellation
    create_pending_resp = await client.post(
        "/jobs",
        json={"payload": {"type": "sleep", "seconds": 10}, "priority": 1}
    )
    assert create_pending_resp.status_code in (200, 201)
    pending_job_id = create_pending_resp.json()["id"]

    # Cancel the pending job (if worker hasn't processed it yet)
    cancel_pending_resp = await client.post(f"/jobs/{pending_job_id}/cancel")
    if cancel_pending_resp.status_code == 200:
        # Confirm removed from Redis pending queue
        assert redis_client.zscore("queue:pending", str(pending_job_id)) is None
        get_pending_resp = await client.get(f"/jobs/{pending_job_id}")
        assert get_pending_resp.json()["status"] == "cancelled"

@pytest.mark.anyio
async def test_submit_invalid_payload_sleep_seconds(client):
    """Submitting a sleep job with invalid or excessive seconds returns 422."""
    resp_neg = await client.post(
        "/jobs",
        json={"payload": {"type": "sleep", "seconds": -5}, "priority": 5}
    )
    assert resp_neg.status_code == 422

    resp_huge = await client.post(
        "/jobs",
        json={"payload": {"type": "sleep", "seconds": 99999}, "priority": 5}
    )
    assert resp_huge.status_code == 422

@pytest.mark.anyio
async def test_retry_cancelled_job(client):
    """Retrying a cancelled job re-enqueues it and restores status to pending."""
    # Create and cancel a job
    create_resp = await client.post(
        "/jobs",
        json={"payload": {"type": "sleep", "seconds": 5}, "priority": 8}
    )
    job_id = create_resp.json()["id"]
    await client.post(f"/jobs/{job_id}/cancel")

    # Retry the job
    retry_resp = await client.post(f"/jobs/{job_id}/retry")
    assert retry_resp.status_code == 200
    data = retry_resp.json()
    assert data["status"] == "pending"
    assert data["attempts"] == 0
    assert data["error"] is None

@pytest.mark.anyio
async def test_dlq_endpoint(client):
    """DLQ endpoint returns job count and list."""
    resp = await client.get("/jobs/dlq")
    assert resp.status_code == 200
    data = resp.json()
    assert "count" in data
    assert "job_ids" in data
    assert isinstance(data["job_ids"], list)

@pytest.mark.anyio
async def test_list_jobs_limit_validation(client):
    """Invalid limit parameter values return 422 validation error."""
    resp_zero = await client.get("/jobs?limit=0")
    assert resp_zero.status_code == 422

    resp_excessive = await client.get("/jobs?limit=1000")
    assert resp_excessive.status_code == 422
