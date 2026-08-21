import redis
from common.config import settings

# Create a shared redis connection
redis_client = redis.from_url(settings.REDIS_URL, decode_responses=True)
