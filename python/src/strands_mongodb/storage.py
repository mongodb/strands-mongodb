"""``MongoDBStorage`` -- MongoDB behind the Strands unified ``Storage`` protocol.

Requires the ``storage`` extra::

    pip install 'strands-mongodb[storage]'

One ``Storage`` instance is consumed by five SDK subsystems -- sessions, context offloading,
memory persistence, context history and transcripts -- via the top-level ``storage`` parameter
on ``Agent``, so a single implementation covers all of them.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from ._extras import missing_extra

# Imported for their side effect of proving the `storage` extra is installed: without it the
# failure would otherwise surface deep inside a method call as a bare ModuleNotFoundError.
try:
    import pymongo  # noqa: F401
    from strands.storage import Storage  # noqa: F401
except ImportError as error:
    missing_extra("storage", error, module=__name__)

from . import _client

if TYPE_CHECKING:
    from .types import MongoDBConfig

__all__ = ["MongoDBStorage"]

# The `Storage` protocol is satisfied structurally and this class does not inherit it, matching all
# three backends the SDK ships (`InMemoryStorage`, `LocalFileStorage`, `S3Storage`). The memory
# surface goes the other way, because both vended memory stores do.


class MongoDBStorage:
    """MongoDB-backed implementation of ``strands.storage.Storage``.

    The connection half arrives as a whole ``MongoDBConfig``, built once per process and reused; the
    per-instance half arrives as keyword arguments, because two storages in one database differ by
    collection and ``namespace()`` returns a second instance differing only by prefix. Passing the
    same config object to every instance is what makes them share one connection pool
    (``REQ-E-012``).

    Example:
        ```python
        config: MongoDBConfig = {"database": "agents", "connection_string": "mongodb+srv://..."}
        sessions = MongoDBStorage(config, collection="sessions")
        transcripts = MongoDBStorage(config, collection="transcripts")  # same pool
        ```

    The five contract methods land in Tasks 5 and 6 and are absent until then, along with
    ``namespace()`` and ``delete_prefix()``. ``for_sandbox`` is absent permanently: the SDK probes it
    with ``hasattr`` and falls back when it is missing, so a stub that raised would break context
    offloading for every MongoDB user rather than degrade it.
    """

    def __init__(
        self,
        config: MongoDBConfig,
        /,
        *,
        collection: str = "storage",
        prefix: str = "",
        ttl_seconds: int | None = None,
    ) -> None:
        """Resolve the shared connection and record this instance's placement in it.

        Args:
            config: Connection and deployment settings. Positional-only, following ``S3Storage``'s
                resource-first shape, and passed whole so it can be shared with a
                ``MongoDBMemoryStore`` through ``MongoDBMemoryStoreConfig.config``.
            collection: Collection holding this instance's documents.
            prefix: Key prefix prepended to every key, scoping this instance within the collection.
            ttl_seconds: Lifetime for documents this instance writes. ``None`` means they never
                expire, which is not the same as ``0``: a MongoDB TTL index with
                ``expireAfterSeconds: 0`` deletes documents as soon as their timestamp passes
                (``REQ-E-035``).

        Raises:
            KeyError: If ``config`` has no ``database``. It is ``Required`` in the ``TypedDict``, so
                mypy rejects a literal that omits it; this catches a config assembled at runtime.
            ValueError: If ``config`` supplies neither ``client`` nor ``connection_string``
                (``REQ-E-015``).
        """
        # `database` is read before `resolve` deliberately. Resolving first would register a
        # connection pool in the process-global registry and only then raise, leaving a pool that no
        # instance owns and no `close()` can reach.
        self._database_name = config["database"]
        self._collection_name = collection
        self._prefix = prefix
        self._ttl_seconds = ttl_seconds
        self._config = config
        self._connection = _client.resolve(config)

    async def close(self) -> None:
        """Release the MongoDB connection, closing the client only if this package built it.

        Not part of the ``Storage`` protocol, which has no ``close()``. It exists because
        ``REQ-E-011`` needs a way to release a client we opened, and it does nothing at all when the
        caller injected their own (``REQ-E-010``).

        Scoped to the **config**, not to this instance: the registry holds one entry per connection
        identity, so this closes the pool every other instance built from the same config is using.
        Call it once at process shutdown rather than in a per-request ``finally``. Idempotent.
        """
        await _client.close(self._config)
