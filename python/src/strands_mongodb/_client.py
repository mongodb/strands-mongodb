"""Connection resolution, ownership and per-loop locking, shared by both public surfaces.

``MongoDBConfig`` is a ``TypedDict``, so it is a plain ``dict`` and cannot hold state. The client
built from it, the lock guarding its one-time setup and its capability probe therefore live in a
module-level registry keyed by connection identity, which is what lets N stores configured from the
same database share one connection pool (``REQ-E-012``).

Private because none of it is a promise. The registry, the identity scheme and ``_Connection`` are all
free to change within 0.1.x.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from dataclasses import dataclass, field
from importlib.metadata import PackageNotFoundError, version
from typing import TYPE_CHECKING, Any

from strands_mongodb._extras import missing_extra

# `storage` rather than `memory`: this module is reachable from both surfaces, and everything it
# needs is in the narrower extra. A `memory`-only install does not exist, since `[memory]` is a
# superset of `[storage]` (REQ-E-002).
try:
    from pymongo import AsyncMongoClient
    from pymongo.driver_info import DriverInfo
except ImportError as error:  # pragma: no cover - exercised in a subprocess by AT-008b
    missing_extra("storage", error, module=__name__)

if TYPE_CHECKING:
    from strands_mongodb.types import MongoDBConfig

__all__ = ["close", "resolve"]

logger = logging.getLogger(__name__)

# The name the server logs and Atlas telemetry group by. Changing it orphans historical usage data.
_DRIVER_NAME = "Strands"

_MISSING_CONNECTION = (
    "strands_mongodb: a MongoDB connection is required, but neither 'client' nor "
    "'connection_string' was set in the configuration. Set 'connection_string' to a MongoDB URI, or "
    "set 'client' to an AsyncMongoClient you already have."
)

_RETRY_WRITES_DISABLED = (
    "retryWrites is disabled on this MongoDB connection. strands_mongodb relies on the driver's own "
    "retry to replay its idempotent upserts across a primary stepdown, and with retryWrites=false "
    "that replay does not happen: a write interrupted by an election surfaces to the caller instead. "
    "Nothing is corrupted either way. Remove retryWrites=false to restore the behavior this package "
    "was designed around."
)

_APPEND_METADATA_UNAVAILABLE = (
    "Could not attach Strands driver attribution to the supplied MongoDB client: this pymongo does "
    "not implement AsyncMongoClient.append_metadata, which was added in pymongo 4.14. Everything "
    "works; only the driver name reported to the server is missing. Upgrade pymongo, or let "
    "strands_mongodb build the client from 'connection_string' instead, which is attributed on every "
    "4.x release."
)


@dataclass
class _Connection:
    """One MongoDB connection and the per-connection state a ``TypedDict`` cannot hold.

    No field holds the connection string. That is not incidental: a dataclass generates a ``__repr__``
    covering every field, so a URI stored here would print its inline password wherever this object is
    rendered (``REQ-E-014``).

    Attributes:
        client: The shared client. Built by us or handed to us.
        owned: Whether we built it. ``False`` for an injected client, which is never closed
            (``REQ-E-010``).
        lock: Guards one-time setup, such as index creation, against N stores racing. Valid only for
            ``loop``; read it through :meth:`get_lock`.
        loop: The event loop ``lock`` is usable on, or ``None`` before its first use.
        capabilities: Result of the server capability probe, or ``None`` until it has run.
    """

    client: AsyncMongoClient[Any]
    owned: bool
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    loop: asyncio.AbstractEventLoop | None = None
    capabilities: Any | None = None

    def get_lock(self) -> asyncio.Lock:
        """Return a lock usable on the running event loop, replacing it if the loop changed.

        ``REQ-E-017``. A synchronous ``Agent`` runs each invocation on a fresh loop, and an
        ``asyncio.Lock`` raises ``RuntimeError: ... is bound to a different event loop`` once it has
        created a waiter future on one loop and is awaited on another.

        Two details make this worth a method rather than a comment. The binding happens **lazily**, on
        contention only, because ``acquire()`` on an unlocked lock returns without touching the loop:
        an uncontended lock crosses loops silently and hides the problem until load arrives. And the
        ``RuntimeError`` is raised *after* the lock marks itself held, so a lock that fails this way
        stays locked forever and every later invocation fails too.

        Replacing the lock is safe here because it only ever guards work scoped to a single loop. A
        lock discarded with waiters on it would strand them, but those waiters live on a loop that has
        already been closed.

        Returns:
            A lock bound to the running loop, stable for the lifetime of that loop.

        Raises:
            RuntimeError: If called with no running event loop, which is a caller bug: every user of
                this lock is a coroutine.
        """
        running = asyncio.get_running_loop()
        if self.loop is not running:
            self.lock = asyncio.Lock()
            self.loop = running
        return self.lock


# Keyed by the digest from `_identity`, never by a connection string (REQ-E-014). Process-global, so
# every store built from one config shares one pool.
_REGISTRY: dict[str, _Connection] = {}


def _package_version() -> str:
    """Return this package's installed version for driver attribution.

    Returns:
        The installed version, or ``"unknown"`` when the package is not installed as a distribution,
        which happens when it is run straight from a source checkout.
    """
    try:
        return version("strands-mongodb")
    except PackageNotFoundError:  # pragma: no cover - requires an uninstalled source checkout
        return "unknown"


def _driver_info() -> DriverInfo:
    """Build the attribution PyMongo appends to its own driver metadata.

    Returns:
        A ``DriverInfo`` naming Strands and the installed package version.
    """
    return DriverInfo(name=_DRIVER_NAME, version=_package_version())


def _identity(config: MongoDBConfig) -> str:
    """Compute the registry key for a config.

    Two configs share a client when they would produce the same one. ``database`` is excluded, since
    one client serves any number of databases, which is the whole point of sharing it.

    An injected client keys on its own object identity rather than on anything about it. Two clients
    built from the same URI are not interchangeable: they can differ in credentials, read preference,
    or timeouts, and nothing here inspects those. Handing one caller the other's client would be worse
    than building two.

    ``client_args`` is part of the identity, because a client built with different timeouts is a
    different client. Without it, the second config's arguments would be silently discarded on the
    cache hit.

    The result is a digest, not the string it summarizes. ``REQ-E-014`` forbids emitting a connection
    string into any ``repr``, and a dict keyed on URIs leaks its keys through ``repr(registry)``, a
    ``KeyError``, and any debugger that walks module globals. A digest preserves the identity
    semantics ``REQ-E-012`` needs and is not reversible into a password.

    Args:
        config: The configuration to key.

    Returns:
        An opaque key, stable for the lifetime of the process.

    Raises:
        ValueError: If neither ``client`` nor ``connection_string`` is set (``REQ-E-015``).
    """
    injected = config.get("client")
    if injected is not None:
        return f"client:{id(injected):x}"

    connection_string = config.get("connection_string")
    if not connection_string:
        raise ValueError(_MISSING_CONNECTION)

    # `default=repr` so an unserializable argument (a `ServerApi`, an SSLContext) still produces a
    # stable key instead of raising. Distinct objects then key distinctly, which errs toward building
    # a second client rather than sharing the wrong one.
    args = json.dumps(config.get("client_args") or {}, sort_keys=True, default=repr)
    digest = hashlib.sha256(f"{connection_string}\x00{args}".encode()).hexdigest()
    return f"uri:{digest}"


def _warn_if_retries_disabled(client: AsyncMongoClient[Any]) -> None:
    """Warn when the resolved client will not retry writes (``REQ-E-016``).

    Read off ``client.options`` rather than parsed out of the connection string. The resolved option is
    the thing that matters, and reading it catches the setting whether it arrived through the URI,
    through ``client_args``, or on a client the caller injected. It also means this package ships no
    URI parser.

    Args:
        client: The client about to be registered.
    """
    if client.options.retry_writes is False:
        logger.warning(_RETRY_WRITES_DISABLED)


def _attribute_injected_client(client: AsyncMongoClient[Any]) -> None:
    """Attach Strands attribution to a client we did not build (``REQ-E-013``).

    This is ``pymongo_search_utils.append_client_metadata`` inlined. That function is three lines and
    would be the obvious thing to call, but it lives in the ``[memory]`` extra, and this module is
    reachable from ``storage.py`` under a ``[storage]``-only install.

    The ``callable`` guard is the whole trick, and it is load bearing rather than defensive. Below
    pymongo 4.14 ``append_metadata`` is not a method: ``AsyncMongoClient.__getattr__`` resolves any
    unknown attribute to a ``Database`` of that name, so the attribute exists, is truthy, and raises
    ``TypeError`` when called. Our declared pymongo floor is 4.12, so that is a supported install.

    Args:
        client: The injected client to attribute in place.
    """
    append = getattr(client, "append_metadata", None)
    if not callable(append):
        logger.info(_APPEND_METADATA_UNAVAILABLE)
        return
    append(_driver_info())


def resolve(config: MongoDBConfig) -> _Connection:
    """Return the shared connection for a config, creating it on first use.

    Args:
        config: The configuration to resolve. Only the connection fields are read.

    Returns:
        The registered connection. The same object for every config with the same connection
        identity, so callers must not mutate it.

    Raises:
        ValueError: If neither ``client`` nor ``connection_string`` is set. Raised before any client
            is built, and nothing is registered (``REQ-E-015``). Nothing downstream would raise it for
            us: pymongo reads a schemeless string as a hostname, so the failure would otherwise be a
            server-selection timeout against ``localhost``.
    """
    key = _identity(config)
    existing = _REGISTRY.get(key)
    if existing is not None:
        # Returning here is what keeps REQ-E-016's warning to one line per connection rather than one
        # per store, and a Storage is resolved once per SDK subsystem that consumes it. Reapplying the
        # attribution would in fact be harmless, since `_update_metadata` dedupes by driver name, but
        # re-warning would not be.
        return existing

    injected = config.get("client")
    if injected is not None:
        _attribute_injected_client(injected)
        _warn_if_retries_disabled(injected)
        _REGISTRY[key] = _Connection(client=injected, owned=False)
        return _REGISTRY[key]

    # `driver=` reaches pymongo through `**kwargs` rather than a named parameter, so nothing type
    # checks it. AT-013a asserts the resulting pool metadata instead of the call.
    connection_string = config["connection_string"]
    client: AsyncMongoClient[Any] = AsyncMongoClient(
        connection_string,
        driver=_driver_info(),
        **(config.get("client_args") or {}),
    )
    _warn_if_retries_disabled(client)
    _REGISTRY[key] = _Connection(client=client, owned=True)
    return _REGISTRY[key]


async def close(config: MongoDBConfig) -> None:
    """Release the connection for a config, closing the client only if we built it.

    ``REQ-E-010`` and ``REQ-E-011``. In an agent process one ``AsyncMongoClient`` is typically shared
    across memory, storage and the application's own queries, so closing an injected one tears down a
    pool that unrelated subsystems are still using. The symptom appears somewhere else, later, which
    is what makes the reference implementation's unconditional ``self.client.close()`` costly.

    Idempotent, and safe on a config that was never resolved. This gets called from a ``finally`` and
    again from an ``atexit``.

    Args:
        config: The configuration whose connection to release.
    """
    try:
        key = _identity(config)
    except ValueError:
        # Nothing was ever registered for a config this broken, so there is nothing to release and no
        # reason to raise from a teardown path.
        return

    connection = _REGISTRY.pop(key, None)
    if connection is None:
        return
    if connection.owned:
        await connection.client.close()
