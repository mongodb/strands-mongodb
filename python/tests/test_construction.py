"""Constructing the two public classes: signature, connection sharing, ownership, teardown.

Task 2's requirements (``REQ-E-010``–``REQ-E-017``) are about connections, and ``test_client.py``
asserts them against ``_client.resolve`` directly. This file asserts the same contract through the
constructors a user actually calls, which is where three of the acceptance tests are worded:
``AT-012`` says *100 stores* yield one client, ``AT-015`` says the rejection happens *at construction
time*, and ``AT-017`` says *two ``asyncio.run`` calls sharing one config*. A registry that behaves
perfectly while ``MongoDBStorage.__init__`` forgets to consult it satisfies none of them.

Nothing here reaches the network. ``AsyncMongoClient`` construction performs no I/O, so a URI
pointing at a closed port is enough to build and register a client, and every test below runs in the
mock tier with no backend configured.
"""

from __future__ import annotations

import asyncio
import inspect
from typing import TYPE_CHECKING, Any

import pytest
from pymongo import AsyncMongoClient
from strands.memory.types import _has_method

from strands_mongodb import _client
from strands_mongodb.memory_store import MongoDBMemoryStore
from strands_mongodb.storage import MongoDBStorage

if TYPE_CHECKING:
    from strands_mongodb.types import MongoDBConfig, MongoDBMemoryStoreConfig

# Port 1 is reserved and never listening, so anything that reaches the network here fails loudly
# instead of finding a stray local mongod and passing for the wrong reason.
#
# The timeout is not decoration. `_is_closed` distinguishes a closed client from a live one by
# probing both, and a live client against a dead port takes `serverSelectionTimeoutMS` to give up:
# at pymongo's 30-second default, the two tests that probe a live injected client took 60 of this
# file's 61 seconds. Setting it in the URI covers the clients this package constructs as well.
UNREACHABLE = "mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=50"


@pytest.fixture(autouse=True)
def _clear_registry() -> Any:
    """Isolate each test from the process-global connection registry.

    Same justification as the fixture of the same name in ``test_client.py``: the registry is
    module-level by design (``REQ-E-012``), so without this a test that constructs a store leaves a
    connection behind for the next one, and ``len(_REGISTRY) == 1`` assertions become order
    dependent.
    """
    _client._REGISTRY.clear()
    yield
    _client._REGISTRY.clear()


def _storage_config(**overrides: Any) -> MongoDBConfig:
    """Build a minimal valid connection config.

    Args:
        **overrides: Fields to set or replace.

    Returns:
        A config with ``database`` and ``connection_string`` set.
    """
    config: dict[str, Any] = {"database": "appdb", "connection_string": UNREACHABLE}
    config.update(overrides)
    return config  # type: ignore[return-value]


def _store_config(**overrides: Any) -> MongoDBMemoryStoreConfig:
    """Build a minimal valid memory-store config, nesting the connection half under ``config``.

    Args:
        **overrides: Top-level store fields to set or replace. Pass ``config=`` to replace the
            connection half.

    Returns:
        A config with ``name`` and a valid nested ``config``.
    """
    store: dict[str, Any] = {"name": "facts", "config": _storage_config()}
    store.update(overrides)
    return store  # type: ignore[return-value]


class TestTheSignaturesThePlanFixes:
    """Plan §8.1 lines 1412 and 1422 — one calling convention per SDK surface.

    The asymmetry is deliberate (plan line 1439) and it is the part most likely to be "tidied" by a
    later reader into a single convention, which would be a breaking change on whichever surface lost.
    Asserted against ``inspect.signature`` rather than by calling, so the test describes the promise
    and not one call that happens to work.
    """

    def test_a_storage_takes_its_connection_config_positionally(self) -> None:
        """``MongoDBStorage(config, /, *, ...)``, matching ``S3Storage``'s resource-first shape."""
        parameters = list(inspect.signature(MongoDBStorage.__init__).parameters.values())

        assert parameters[1].name == "config"
        assert parameters[1].kind is inspect.Parameter.POSITIONAL_ONLY

    def test_the_storage_options_are_keyword_only_with_the_documented_defaults(self) -> None:
        """``collection``, ``prefix`` and ``ttl_seconds`` are per-instance, so they are not in the config.

        Keyword-only because ``MongoDBStorage(config, "sessions")`` reads as if the second argument
        were a key or a prefix, and the three of them are not in an order anyone would remember.
        """
        parameters = inspect.signature(MongoDBStorage.__init__).parameters

        for name, default in (("collection", "storage"), ("prefix", ""), ("ttl_seconds", None)):
            assert parameters[name].kind is inspect.Parameter.KEYWORD_ONLY, name
            assert parameters[name].default == default, name

    def test_passing_the_storage_config_by_keyword_is_rejected(self) -> None:
        """Positional-only is enforced by the interpreter, not merely documented.

        ``config=`` would otherwise be absorbed as an unexpected keyword and the failure would be a
        ``TypeError`` about ``config`` either way, so this asserts the parameter really is marked
        positional-only rather than trusting the same message twice.
        """
        with pytest.raises(TypeError):
            MongoDBStorage(config=_storage_config())  # type: ignore[misc, call-arg]

    def test_a_memory_store_takes_its_whole_config_as_keyword_arguments(self) -> None:
        """``MongoDBMemoryStore(**config)``, matching ``BedrockKnowledgeBaseStore``.

        The SDK's ``MemoryManager`` never constructs a store, so this convention exists for the
        caller's benefit: ``name=`` and ``writable=`` read as fields of the store, and they are
        declared in a ``TypedDict`` that extends the SDK's own ``MemoryStoreConfig``.
        """
        parameters = list(inspect.signature(MongoDBMemoryStore.__init__).parameters.values())

        assert len(parameters) == 2, "self plus one **kwargs parameter, nothing positional"
        assert parameters[1].kind is inspect.Parameter.VAR_KEYWORD


class TestOneClientPerConfigAcrossBothSurfaces:
    """AT-012 / REQ-E-012 — N instances from one config, one connection pool.

    The count in ``AT-012`` is not decoration. A multi-tenant application builds one store per user
    per request, and each ``AsyncMongoClient`` opens its own pool with its own monitoring threads, so
    the failure mode is not "slightly wasteful": it is a connection count that grows with traffic
    until the deployment refuses new connections.
    """

    def test_100_storages_from_one_config_share_one_client(self) -> None:
        """One config object passed 100 times yields one pool."""
        config = _storage_config()

        storages = [MongoDBStorage(config) for _ in range(100)]

        clients = {id(storage._connection.client) for storage in storages}
        assert len(clients) == 1
        assert len(_client._REGISTRY) == 1

    def test_100_memory_stores_from_one_config_share_one_client(self) -> None:
        """The memory surface reaches the same registry, through its nested ``config`` key."""
        connection = _storage_config()

        stores = [MongoDBMemoryStore(**_store_config(config=connection, name=f"facts{index}")) for index in range(100)]

        clients = {id(store._connection.client) for store in stores}
        assert len(clients) == 1
        assert len(_client._REGISTRY) == 1

    def test_a_storage_and_a_memory_store_sharing_a_config_share_one_client(self) -> None:
        """``REQ-E-012`` says "stores or storages", and the two surfaces are separate modules.

        The likely way to fail this is per-module state: a registry defined in ``storage.py`` and
        another in ``memory_store.py`` would pass both tests above and still open two pools for an
        agent that uses memory and session storage against one database, which is the common case.
        """
        connection = _storage_config()

        storage = MongoDBStorage(connection)
        store = MongoDBMemoryStore(**_store_config(config=connection))

        assert storage._connection.client is store._connection.client
        assert len(_client._REGISTRY) == 1

    def test_two_storages_differing_only_by_collection_share_one_client(self) -> None:
        """A per-instance option is not part of the connection identity.

        Sessions and transcripts land in different collections of one database, and that must not
        cost a second pool. ``collection`` is a constructor argument rather than a config field
        precisely so it stays out of the identity computed from the config.
        """
        connection = _storage_config()

        sessions = MongoDBStorage(connection, collection="sessions")
        transcripts = MongoDBStorage(connection, collection="transcripts")

        assert sessions._connection.client is transcripts._connection.client
        assert len(_client._REGISTRY) == 1


class TestABadConfigIsRejectedAtConstruction:
    """AT-015 / REQ-E-015 — the failure happens where the caller can see it.

    ``REQ-E-015`` says "at construction time" and the reason is upstream behavior, not tidiness.
    pymongo validates nothing about a connection string: ``AsyncMongoClient("not-a-uri")`` succeeds,
    reading the string as a hostname. Deferring the check to first use would turn a missing setting
    into a 30-second server-selection timeout against ``localhost``, raised from inside whichever SDK
    subsystem happened to touch storage first.
    """

    def test_a_storage_with_no_way_to_reach_the_database_raises_value_error(self) -> None:
        """Neither ``client`` nor ``connection_string``, so there is nothing to connect to."""
        with pytest.raises(ValueError, match="connection_string"):
            MongoDBStorage({"database": "appdb"})

    def test_a_memory_store_with_no_way_to_reach_the_database_raises_value_error(self) -> None:
        """Same rejection through the nested config, which is the easier of the two to get wrong."""
        with pytest.raises(ValueError, match="connection_string"):
            MongoDBMemoryStore(name="facts", config={"database": "appdb"})

    def test_a_rejected_config_leaves_nothing_registered(self) -> None:
        """A failed construction must not leave a pool behind for a later config to find."""
        with pytest.raises(ValueError):
            MongoDBStorage({"database": "appdb"})

        assert _client._REGISTRY == {}

    @pytest.mark.parametrize("surface", ["storage", "memory"])
    def test_a_config_with_no_database_is_rejected_before_a_client_is_built(self, surface: str) -> None:
        """``database`` is read first, so an incomplete config does not register a pool it then abandons.

        Read with a bare subscript, following ``BedrockKnowledgeBaseStore``'s
        ``kb_config["knowledge_base_id"]``: the key is ``Required`` in the ``TypedDict``, so mypy
        rejects a literal that omits it and the runtime failure is for a config assembled
        dynamically.

        The assertion that matters is the second one. Reading ``database`` *after* resolving would
        raise the same ``KeyError`` while leaving a registered connection pool that no object owns and
        no ``close()`` will ever reach.
        """
        with pytest.raises(KeyError, match="database"):
            if surface == "storage":
                MongoDBStorage({"connection_string": UNREACHABLE})  # type: ignore[typeddict-item]
            else:
                MongoDBMemoryStore(name="facts", config={"connection_string": UNREACHABLE})  # type: ignore[typeddict-item]

        assert _client._REGISTRY == {}

    def test_a_memory_store_without_a_name_is_rejected(self) -> None:
        """``name`` is the store config's own mandatory key, and the SDK targets stores by it.

        ``MemoryManager`` looks stores up by name and the ``search_memory`` tool takes one, so a store
        with no name is unreachable through every SDK entry point that is not a direct reference.

        The ``type: ignore`` code is worth reading: because the config arrives as keyword arguments,
        mypy reports the omission as ``Missing named argument "name"``, a plain ``call-arg`` error
        rather than a ``TypedDict`` one. The runtime check below is what catches a config assembled
        from a dict at runtime, which is the only way to reach it.
        """
        with pytest.raises(KeyError, match="name"):
            MongoDBMemoryStore(config=_storage_config())  # type: ignore[call-arg]


async def _is_closed(client: AsyncMongoClient[Any]) -> bool:
    """Whether a client has been closed, without needing a reachable server.

    ``AsyncMongoClient`` exposes no public closed flag. A closed client raises ``InvalidOperation``
    from any operation, immediately and without touching the network, while a live client against a
    dead port raises ``ServerSelectionTimeoutError`` after its timeout. Only the first is the answer
    to this question.

    Args:
        client: The client to probe.

    Returns:
        ``True`` if the client refuses to operate because it was closed.
    """
    from pymongo.errors import InvalidOperation

    try:
        await client.admin.command("ping")
    except InvalidOperation:
        return True
    except Exception:  # noqa: BLE001 - any other failure means the client was still willing to try
        return False
    return False


class TestOwnershipSurvivesTheStoreBoundary:
    """AT-010, AT-011 / REQ-E-010, REQ-E-011 — who built the client decides who may close it.

    Worth asserting again at this level even though ``test_client.py`` covers ``_client.close``. The
    reference implementation the plan reviews (§803) calls ``self.client.close()`` from the store
    unconditionally, so the defect this guards against lives in the store's ``close()``, not in the
    connection module.
    """

    async def test_a_storage_closes_the_client_it_built(self) -> None:
        """We opened the pool, so we are the only thing that can be relied on to close it."""
        storage = MongoDBStorage(_storage_config())
        client = storage._connection.client

        await storage.close()

        assert await _is_closed(client)

    async def test_a_storage_never_closes_an_injected_client(self) -> None:
        """The caller's client outlives us.

        In an agent process one client is typically shared between memory, storage and the
        application's own queries. Closing it here tears down a pool other subsystems are still
        using, and the symptom surfaces somewhere else, later.
        """
        injected: AsyncMongoClient[Any] = AsyncMongoClient(UNREACHABLE)
        try:
            storage = MongoDBStorage({"database": "appdb", "client": injected})

            await storage.close()

            assert not await _is_closed(injected)
        finally:
            await injected.close()

    async def test_a_memory_store_closes_the_client_it_built(self) -> None:
        """The same rule on the memory surface, which reads its connection from a nested key."""
        store = MongoDBMemoryStore(**_store_config())
        client = store._connection.client

        await store.close()

        assert await _is_closed(client)

    async def test_a_memory_store_never_closes_an_injected_client(self) -> None:
        """The nested config is where an injected client is easiest to lose track of."""
        injected: AsyncMongoClient[Any] = AsyncMongoClient(UNREACHABLE)
        try:
            store = MongoDBMemoryStore(name="facts", config={"database": "appdb", "client": injected})

            await store.close()

            assert not await _is_closed(injected)
        finally:
            await injected.close()

    async def test_closing_twice_is_a_no_op(self) -> None:
        """``close()`` gets called from a ``finally`` and again from an ``atexit`` in real code."""
        storage = MongoDBStorage(_storage_config())

        await storage.close()
        await storage.close()

    async def test_closing_one_instance_releases_the_connection_the_others_share(self) -> None:
        """The sharp edge of ``REQ-E-012``, asserted rather than left to be discovered.

        One registry entry per connection identity means ``close()`` is per-config, not per-instance:
        the second storage here is left holding a closed client. That is the documented behavior, and
        it is why ``close()`` belongs at process shutdown rather than in a per-request ``finally``
        around one store of several. A reference-counted alternative is open item **O-10**.
        """
        connection = _storage_config()
        first = MongoDBStorage(connection, collection="sessions")
        second = MongoDBStorage(connection, collection="transcripts")

        await first.close()

        assert await _is_closed(second._connection.client)
        assert _client._REGISTRY == {}


class TestTheCollectionAndOptionsTheCallerAsksFor:
    """The per-instance settings are recorded as given, with the defaults the specs document.

    Two collection defaults rather than one, because the two surfaces hold unrelated data in the same
    database: ``"storage"`` for the ``Storage`` contract's opaque bytes (plan §8.1 line 1422) and
    ``"memory"`` for ``MemoryEntry`` documents with a vector index on them
    (``MongoDBMemoryStoreConfig.collection``). Defaulting both to one name would put session blobs and
    searchable memories in one collection, where the vector index would try to embed base64.
    """

    def test_a_storage_defaults_to_the_storage_collection(self) -> None:
        """Plan §8.1 line 1422."""
        assert MongoDBStorage(_storage_config())._collection_name == "storage"

    def test_a_memory_store_defaults_to_the_memory_collection(self) -> None:
        """``MongoDBMemoryStoreConfig.collection``: "Defaults to ``"memory"``"."""
        assert MongoDBMemoryStore(**_store_config())._collection_name == "memory"

    def test_the_storage_options_are_recorded_as_passed(self) -> None:
        """All three, in one test, because the failure worth catching is a swap between them."""
        storage = MongoDBStorage(_storage_config(), collection="sessions", prefix="tenant-a/", ttl_seconds=3600)

        assert storage._collection_name == "sessions"
        assert storage._prefix == "tenant-a/"
        assert storage._ttl_seconds == 3600

    def test_a_storage_without_a_ttl_records_no_expiry_rather_than_zero(self) -> None:
        """``REQ-E-035``: documents written without ``ttl_seconds`` never expire.

        ``None`` and ``0`` are opposites here and both are falsy. A MongoDB TTL index with
        ``expireAfterSeconds: 0`` expires documents the moment ``expires_at`` passes, so collapsing
        the default to ``0`` somewhere between here and Task 5 deletes data instead of keeping it
        forever.
        """
        assert MongoDBStorage(_storage_config())._ttl_seconds is None

    def test_the_database_named_in_the_config_is_the_one_recorded(self) -> None:
        """One client serves many databases, so the name has to be kept per instance.

        It is deliberately not part of the connection identity: two storages on different databases of
        one deployment share a pool (``REQ-E-012``), which only works if each remembers its own
        database rather than reading it back off the shared connection.
        """
        storage = MongoDBStorage(_storage_config(database="tenant_a"))
        store = MongoDBMemoryStore(**_store_config(config=_storage_config(database="tenant_b")))

        assert storage._database_name == "tenant_a"
        assert store._database_name == "tenant_b"


class TestOneConfigAcrossTwoEventLoops:
    """AT-017 / REQ-E-017, boundary B-8 — a synchronous ``Agent`` runs each invocation on a new loop.

    Two real ``asyncio.run`` calls, as ``tasks.md`` requires: one loop with two tasks does not
    reproduce the failure. Neither does an uncontended lock. ``asyncio.Lock`` has bound lazily since
    3.10, so ``acquire()`` on an unlocked lock returns without ever asking which loop it is on, and a
    test that merely crosses loops passes against an implementation that never rebinds.

    The failure this prevents is also unrecoverable rather than transient: ``RuntimeError: ... is bound
    to a different event loop`` is raised *after* the lock marks itself held, so the lock stays locked
    forever and every later invocation fails too. An agent that works once and then hangs.
    """

    def test_two_asyncio_run_calls_sharing_one_config_both_succeed(self) -> None:
        """The second invocation must not inherit a lock bound to the first one's closed loop."""
        config = _storage_config()

        async def invocation() -> AsyncMongoClient[Any]:
            storage = MongoDBStorage(config)

            async def hold() -> None:
                async with storage._connection.get_lock():
                    await asyncio.sleep(0.01)

            await asyncio.gather(hold(), hold())
            return storage._connection.client

        first = asyncio.run(invocation())
        second = asyncio.run(invocation())

        assert first is second, "the point is that the second run reuses the first run's connection"


class TestTheHooksThatMustStayAbsent:
    """§4.4 and §4.5 — two optional SDK hooks where a raising stub is worse than nothing.

    Both are feature-detected: ``_resolve_namespace`` calls ``for_sandbox`` only when the attribute is
    present, and ``MemoryManager`` routes extraction through ``add_messages`` only when
    ``_has_method`` reports it. Defining either as ``raise NotImplementedError`` converts "the SDK
    picks another path" into "the SDK crashes", and for ``for_sandbox`` the path it would break is
    context offloading for every MongoDB user (premortem **P-4**).

    Neither class inherits its Protocol, so ``hasattr`` is exact for both: there is no base to inherit
    a stub from. ``_has_method`` is asserted alongside it for ``add_messages`` because that is the
    probe the manager actually reads, and the two would disagree if this class ever started inheriting
    ``MemoryStore``.
    """

    def test_a_storage_does_not_define_for_sandbox(self) -> None:
        """``hasattr`` is the probe ``_resolve_namespace`` uses, so it is the one that decides this."""
        assert not hasattr(MongoDBStorage(_storage_config()), "for_sandbox")

    def test_a_memory_store_does_not_implement_add_messages(self) -> None:
        """Asserted with the SDK's own detector, against the class rather than the instance.

        ``AddMessagesContext`` carries no run-unique identifier, so no durable dedup token can be
        built from it, and extraction writes are at-least-once. Implementing this method would make
        duplicate facts a design feature (plan §3.2, §3.4(a), **REL-6**). The manager's fallback is
        its own ``ModelExtractor`` plus our ``add``, which does dedupe.
        """
        store = MongoDBMemoryStore(**_store_config())

        assert not hasattr(store, "add_messages")
        assert _has_method(store, "add_messages") is False
