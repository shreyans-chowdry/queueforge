import asyncio

import pytest

from api.websocket import ConnectionManager


@pytest.mark.anyio
async def test_broadcast_removes_broken_clients_without_skipping_healthy_clients():
    manager = ConnectionManager()
    delivered = []
    class Client:
        def __init__(self, broken=False):
            self.broken = broken
        async def send_json(self, message):
            if self.broken:
                raise ConnectionError("gone")
            delivered.append(message)
            await asyncio.sleep(0)
        async def close(self):
            pass
    broken, healthy = Client(True), Client()
    manager.active_connections = [broken, healthy]
    await manager.broadcast({"status": "completed"})
    assert delivered == [{"status": "completed"}]
    assert manager.active_connections == [healthy]
