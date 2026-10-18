import asyncio
import json
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from typing import List
import redis.asyncio as aioredis
from common.config import settings

# Why the API process subscribes to Pub/Sub instead of the worker talking directly to WebSockets:
# Workers and the API are separate processes (and potentially running in completely separate 
# Docker containers). They do not share memory. The worker has no knowledge of which dashboard 
# clients are connected to the API. Redis Pub/Sub acts as the reliable bridge between them,
# allowing workers to fire-and-forget events, while the API handles fanning those events out 
# to all connected WebSocket clients.

router = APIRouter(prefix="/ws", tags=["websocket"])

class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def broadcast(self, message: dict):
        async def send(connection):
            try:
                await asyncio.wait_for(connection.send_json(message), timeout=2)
            except Exception:
                self.disconnect(connection)
                try:
                    await asyncio.wait_for(connection.close(), timeout=1)
                except Exception:
                    pass

        # Snapshot the list: disconnects must not skip another client. A slow
        # browser cannot block delivery to the rest of the fleet.
        await asyncio.gather(*(send(connection) for connection in tuple(self.active_connections)))

manager = ConnectionManager()

@router.websocket("/jobs")
async def websocket_jobs(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            # We don't expect messages from the client in this one-way dashboard pipe,
            # but we need to wait on receive() to detect client disconnections gracefully.
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception:
        manager.disconnect(websocket)

async def pubsub_listener():
    # Use the asyncio Redis client to avoid blocking the FastAPI event loop
    while True:
        redis_conn = None
        pubsub = None
        try:
            redis_conn = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
            pubsub = redis_conn.pubsub()
            await pubsub.subscribe("job_events")
            
            async for message in pubsub.listen():
                if message["type"] == "message":
                    try:
                        data = json.loads(message["data"])
                        await manager.broadcast(data)
                    except Exception as e:
                        print(f"Error broadcasting message: {e}")
        except asyncio.CancelledError:
            break
        except Exception as e:
            print(f"Redis pubsub connection error: {e}. Reconnecting in 2s...")
            await asyncio.sleep(2)
        finally:
            if pubsub:
                try:
                    await pubsub.unsubscribe("job_events")
                    await pubsub.aclose()
                except Exception:
                    pass
            if redis_conn:
                try:
                    await redis_conn.aclose()
                except Exception:
                    pass
