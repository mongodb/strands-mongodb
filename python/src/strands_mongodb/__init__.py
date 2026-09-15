"""MongoDB storage and memory backends for the Strands Agents SDK.

Two surfaces, each behind its own install extra:

- :mod:`strands_mongodb.storage` -- ``MongoDBStorage``, implementing the SDK's unified
  ``strands.storage.Storage`` protocol. Install with ``pip install 'strands-mongodb[storage]'``.
- :mod:`strands_mongodb.memory_store` -- ``MongoDBMemoryStore``, implementing the SDK's
  ``strands.memory.MemoryStore`` protocol. Install with ``pip install 'strands-mongodb[memory]'``.

Both classes are reachable from here, resolved on first attribute access rather than at import
time. Importing this package must never pull a dependency the caller did not ask for: a
``[storage]``-only install can ``import strands_mongodb`` and use ``MongoDBStorage`` without ever
executing the memory module, which would fail on ``pymongo_search_utils``.
"""

from __future__ import annotations

from importlib import import_module
from importlib.metadata import PackageNotFoundError, version
from typing import TYPE_CHECKING, Final

if TYPE_CHECKING:
    # Declared for type checkers only. A module-level `__getattr__` is invisible to them, so
    # without these the lazily exported names would resolve to `object` and every downstream use
    # would lose its types. Never executed at runtime, which is the point.
    from strands_mongodb.memory_store import MongoDBMemoryStore
    from strands_mongodb.storage import MongoDBStorage

try:
    __version__ = version("strands-mongodb")
except PackageNotFoundError:
    # Imported from a source tree that was never installed.
    __version__ = "0.0.0+unknown"

__all__ = ["MongoDBMemoryStore", "MongoDBStorage", "__version__"]

_LAZY: Final[dict[str, str]] = {
    "MongoDBStorage": "strands_mongodb.storage",
    "MongoDBMemoryStore": "strands_mongodb.memory_store",
}


def __getattr__(name: str) -> object:
    """Resolve a backend class on first access, importing only its own module.

    PEP 562. The return type is ``object`` and not ``Any`` on purpose: a module-level
    ``__getattr__`` makes a type checker accept every attribute name on this module, so ``Any``
    would silently type check any misspelling and everything done with it. With ``object``, the
    access still passes but the first real use of a typo is rejected.

    Args:
        name: The attribute being looked up.

    Returns:
        The class named by ``name``.

    Raises:
        AttributeError: If ``name`` is not a lazily exported class. Not ``KeyError``:
            :func:`hasattr` converts only ``AttributeError`` to ``False``, and ``inspect``,
            ``copy``, ``pickle`` and REPL display hooks all probe modules for attributes that do
            not exist here.
    """
    module_name = _LAZY.get(name)
    if module_name is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    return getattr(import_module(module_name), name)


def __dir__() -> list[str]:
    """List the lazily exported names alongside the eager ones.

    Without this, ``dir(strands_mongodb)`` omits both classes until something has already
    imported them, so tab completion would show them only after the user knew to type them.

    Returns:
        The module's attribute names, sorted.
    """
    return sorted({*globals(), *_LAZY})
