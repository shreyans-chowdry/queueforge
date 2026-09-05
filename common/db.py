from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from common.config import settings

engine = create_engine(
    settings.DATABASE_URL,
    pool_size=25,
    max_overflow=50,
    pool_timeout=30,
    pool_recycle=300,
    pool_pre_ping=True
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
