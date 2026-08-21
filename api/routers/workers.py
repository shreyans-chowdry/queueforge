from fastapi import APIRouter
from common.queue_engine import get_all_workers

router = APIRouter(prefix="/workers", tags=["workers"])

@router.get("")
def list_workers():
    """
    Returns the cluster's worker registry showing health status.
    """
    return get_all_workers()
