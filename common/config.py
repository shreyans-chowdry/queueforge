from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import field_validator

class Settings(BaseSettings):
    DATABASE_URL: str
    REDIS_URL: str

    @field_validator("DATABASE_URL")
    @classmethod
    def use_installed_driver(cls, value: str) -> str:
        # SQLAlchemy 2.1 changed the default PostgreSQL driver to psycopg 3;
        # this project installs psycopg2. Keep existing .env URLs working.
        if value.startswith("postgresql://"):
            return value.replace("postgresql://", "postgresql+psycopg2://", 1)
        return value
    
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

settings = Settings()
