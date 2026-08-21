import pytest
import httpx
import uuid
from datetime import datetime, timedelta, timezone
from api.main import app

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
    """Cancelling a pending/delayed job changes its status to cancelled."""
    # Schedule job in the future to avoid worker race condition
    future_time = (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat()
    create_response = await client.post(
        "/jobs",
        json={
            "payload": {"type": "sleep", "seconds": 5},
            "priority": 3,
            "execute_at": future_time
        }
    )
    assert create_response.status_code in (200, 201)
    job_id = create_response.json()["id"]
    assert create_response.json()["status"] == "delayed"

    # Cancel the job
    cancel_response = await client.post(f"/jobs/{job_id}/cancel")
    assert cancel_response.status_code == 200
    assert "cancelled successfully" in cancel_response.json().get("message", "").lower()

    # Verify status changed in database
    get_response = await client.get(f"/jobs/{job_id}")
    assert get_response.status_code == 200
    assert get_response.json()["status"] == "cancelled"
