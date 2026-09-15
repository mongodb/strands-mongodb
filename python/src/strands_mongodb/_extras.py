"""Actionable import errors for surfaces whose install extra is missing."""

from __future__ import annotations

from typing import NoReturn


def missing_extra(extra: str, error: ImportError, *, module: str) -> NoReturn:
    """Re-raise an import failure as a message naming the extra that fixes it.

    A bare ``pip install strands-mongodb`` installs no runtime dependencies, so importing a
    backend without its extra otherwise surfaces as a bare ``ModuleNotFoundError`` for
    ``pymongo`` or ``strands`` that gives the caller nothing to act on.

    ``module`` is passed rather than derived from ``extra``, because the two diverge:
    ``strands_mongodb.memory_store`` is installed by ``strands-mongodb[memory]``. Every caller
    passes its own ``__name__``, so the path in the message is the path that failed.

    Args:
        extra: The extra providing this surface's dependencies -- ``storage`` or ``memory``.
        error: The original import failure.
        module: The importing module's ``__name__``.

    Raises:
        ImportError: Always, chained to ``error``, carrying the pip command that resolves it.
    """
    raise ImportError(
        f"{module} requires the '{extra}' extra, which is not installed.\n"
        f"\n"
        f"    pip install 'strands-mongodb[{extra}]'\n"
        f"\n"
        f"Or install every surface at once:\n"
        f"\n"
        f"    pip install 'strands-mongodb[all]'\n"
        f"\n"
        f"Keep the quotes -- zsh and fish expand unquoted brackets as a glob and the command "
        f"fails before pip runs.\n"
        f"Missing module: {error.name or error}"
    ) from error
