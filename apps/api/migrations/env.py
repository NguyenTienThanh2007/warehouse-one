"""Alembic environment. Uses the same settings as the API so there is one source of DB config."""

from logging.config import fileConfig

from alembic import context
from sqlalchemy import create_engine, pool

from warehouse_api.config import get_settings
from warehouse_api.store.tables import metadata

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# Used for `alembic revision --autogenerate` and the schema-drift test; migrations stay explicit.
target_metadata = metadata


def run_migrations_offline() -> None:
    context.configure(
        url=str(get_settings().database_url),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    engine = create_engine(str(get_settings().database_url), poolclass=pool.NullPool)
    with engine.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            include_schemas=True,
            include_name=lambda name, type_, _parent: (
                type_ != "schema" or name in {"operations", "pipeline", "analytics", "twin"}
            ),
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
