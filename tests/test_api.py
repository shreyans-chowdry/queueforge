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


@pytest.mark.anyio
@pytest.mark.parametrize("payload", [
    {"type": "unknown"}, {"type": "sleep", "seconds": True},
    {"type": "compute", "iterations": "100"},
    {"type": "compute", "iterations": 1.5},
    {"type": "compute", "iterations": 2000001},
    {"type": "compute", "iterations": False},
])
async def test_reject_unsupported_payloads(client, payload):
    assert (await client.post("/jobs", json={"payload": payload})).status_code == 422


@pytest.mark.anyio
async def test_cancel_cannot_race_a_worker_claim(client):
    from common.queue_engine import dequeue
    job_id = (await client.post("/jobs", json={"payload": {"type": "sleep"}})).json()["id"]
    assert dequeue("racing_worker", 30000) == job_id
    response = await client.post(f"/jobs/{job_id}/cancel")
    assert response.status_code == 409
    assert (await client.get(f"/jobs/{job_id}")).json()["status"] != "cancelled"


@pytest.mark.anyio
async def test_cancel_after_delayed_job_was_promoted(client):
    from common.queue_engine import promote_due_delayed_jobs, get_now_ms
    future = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
    job_id = (await client.post("/jobs", json={"payload": {"type": "sleep"}, "execute_at": future})).json()["id"]
    redis_client.zadd("queue:delayed", {job_id: get_now_ms() - 1})
    promote_due_delayed_jobs()
    assert (await client.post(f"/jobs/{job_id}/cancel")).status_code == 200
    assert redis_client.zscore("queue:pending", job_id) is None


@pytest.mark.anyio
async def test_enqueue_outage_is_visible_and_retryable(client, monkeypatch):
    from redis.exceptions import ConnectionError
    import api.routers.jobs as routes
    def unavailable(*args, **kwargs):
        raise ConnectionError("private connection details")
    with monkeypatch.context() as patch:
        patch.setattr(routes, "enqueue", unavailable)
        response = await client.post("/jobs", json={"payload": {"type": "sleep"}})
    assert response.status_code == 503
    job_id = response.json()["detail"]["job_id"]
    assert (await client.get(f"/jobs/{job_id}")).json()["status"] == "failed"
    assert "private" not in response.text
    assert (await client.post(f"/jobs/{job_id}/retry")).json()["status"] == "pending"


@pytest.mark.anyio
async def test_pubsub_outage_does_not_fail_committed_submission(client, monkeypatch):
    from redis.exceptions import ConnectionError
    import api.routers.jobs as routes
    def unavailable(*args, **kwargs):
        raise ConnectionError("pubsub down")
    monkeypatch.setattr(routes, "publish_job_event", unavailable)
    response = await client.post("/jobs", json={"payload": {"type": "sleep"}})
    assert response.status_code == 201
    assert redis_client.zscore("queue:pending", response.json()["id"]) is not None


@pytest.mark.anyio
async def test_list_jobs_offset_and_dlq_total(client):
    ids = []
    for _ in range(3):
        ids.append((await client.post("/jobs", json={"payload": {"type": "sleep"}})).json()["id"])
    first = (await client.get("/jobs?limit=2")).json()
    second = (await client.get("/jobs?limit=2&offset=2")).json()
    assert len(first) == 2 and len(second) == 1
    assert {job["id"] for job in first + second} == set(ids)
    assert (await client.get("/jobs?offset=-1")).status_code == 422
    redis_client.rpush("queue:dead_letter", *[str(uuid.uuid4()) for _ in range(105)])
    dlq = (await client.get("/jobs/dlq")).json()
    assert dlq["count"] == 105 and len(dlq["job_ids"]) == 100


@pytest.mark.anyio
@pytest.mark.parametrize("value", ["NaN", "Infinity", "-Infinity"])
async def test_nonfinite_numbers_return_validation_errors_not_500(client, value):
    response = await client.post("/jobs", content='{"payload":{"type":"sleep","seconds":' + value + '}}', headers={"Content-Type": "application/json"})
    assert response.status_code == 422
    nested = await client.post("/jobs", content='{"payload":{"type":"compute","metadata":[' + value + ']}}', headers={"Content-Type": "application/json"})
    assert nested.status_code == 422
