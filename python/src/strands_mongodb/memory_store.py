"""``MongoDBMemoryStore`` -- Atlas Vector Search behind the Strands ``MemoryStore`` protocol.

Requires the ``memory`` extra, whose name does not match this module's::

    pip install 'strands-mongodb[memory]'

Registered with the SDK's ``MemoryManager`` alongside any other stores. The protocol requires
only ``search``; ``add`` and ``add_messages`` are optional and feature-detected by the manager.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from ._extras import missing_extra

# Imported for their side effect of proving the `memory` extra is installed: without it the
# failure would otherwise surface deep inside a method call as a bare ModuleNotFoundError.
try:
    import pymongo  # noqa: F401
    from pymongo_search_utils import __name__ as _pymongo_search_utils  # noqa: F401
    from strands.memory import MemoryStore  # noqa: F401
except ImportError as error:
    missing_extra("memory", error, module=__name__)

from . import _client

if TYPE_CHECKING:
    from typing_extensions import Unpack

    from .types import MongoDBMemoryStoreConfig

__all__ = ["MongoDBMemoryStore"]

DEFAULT_COLLECTION = "memory"
"""Collection this store uses when the config names none.

Distinct from ``MongoDBStorage``'s ``"storage"`` on purpose. The two surfaces hold unrelated shapes:
opaque bytes under an ``_id`` on one side, ``MemoryEntry`` text with a vector index over it on the
other. One default for both would put session blobs in the collection whose index tries to embed
them.
"""


class MongoDBMemoryStore:
    """Atlas Vector Search implementation of ``strands.memory.MemoryStore``.

    Satisfies the Protocol structurally and does not inherit it, unlike ``FileMemoryStore`` and
    ``BedrockKnowledgeBaseStore``, which both do. Inheriting a ``Protocol`` makes every member the
    subclass leaves out abstract, and mypy then refuses to instantiate the subclass at all: checking
    ``FileMemoryStore(name="x")`` reports *Cannot instantiate abstract class "FileMemoryStore" with
    abstract attributes "add_messages", "get_tools" and "initialize"*. Following the convention here
    would hand every type-checked consumer an error on the constructor call with no way to fix it.

    ``add_messages`` is absent, and must stay absent rather than become a stub that raises:
    ``AddMessagesContext`` carries no run-unique identifier, so no dedup token that survives a retry
    can be built from it, while extraction writes are at-least-once. The manager feature-detects it
    with ``_has_method`` and falls back to its own ``ModelExtractor`` feeding ``add``, which dedupes.

    Example:
        ```python
        connection: MongoDBConfig = {"database": "agents", "connection_string": "mongodb+srv://..."}
        store = MongoDBMemoryStore(name="preferences", config=connection, scope="user-abc")
        ```

    ``search``, ``add`` and ``initialize`` land in Task 8, along with the remaining
    ``MemoryStoreConfig`` fields (``description``, ``max_search_results``, ``writable``,
    ``extraction``) and the scope, filter and score bounds. Only the connection contract
    (``REQ-E-010``-``REQ-E-017``) is wired here.
    """

    def __init__(self, **config: Unpack[MongoDBMemoryStoreConfig]) -> None:
        """Resolve the shared connection and record this store's identity and placement.

        Args:
            **config: See ``MongoDBMemoryStoreConfig``. The connection half is nested under
                ``config``, following ``BedrockKnowledgeBaseStore``, so one ``MongoDBConfig`` can be
                shared with a ``MongoDBStorage`` and with every other store in the process.

        Raises:
            KeyError: If ``name`` or the nested ``config`` is absent, or if that config names no
                ``database``. All three are ``Required`` keys, so mypy rejects a literal that omits
                one.
            ValueError: If the nested config supplies neither ``client`` nor ``connection_string``
                (``REQ-E-015``).
        """
        connection = config["config"]
        self.name = config["name"]
        # Read before `resolve`, for the same reason as in `MongoDBStorage`: a config that fails
        # validation must not leave a registered connection pool behind that nothing owns.
        self._database_name = connection["database"]
        self._collection_name = config.get("collection", DEFAULT_COLLECTION)
        self._config = config
        self._connection_config = connection
        self._connection = _client.resolve(connection)

    async def close(self) -> None:
        """Release the MongoDB connection, closing the client only if this package built it.

        Not part of the ``MemoryStore`` protocol, so ``MemoryManager`` never calls it. Same scope as
        ``MongoDBStorage.close``: per config rather than per store, because one registry entry serves
        every store built from that config. Idempotent, and a no-op for an injected client
        (``REQ-E-010``).
        """
        await _client.close(self._connection_config)
