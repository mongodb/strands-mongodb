"""Caller-filter validation and scope composition, shared by the search paths.

Two guards and one composer, all pure functions over plain dicts. No pymongo import, no I/O, nothing
that needs a deployment, which is deliberate: this is the code path premortem **P-1** runs through, and
a security guard that can only be tested against a live cluster gets tested less often.

The guards are independent on purpose (§4.3). ``REQ-E-050`` is about what a key *is*, and
``REQ-E-049`` is about whether the index declared it. Collapsing them into one pass would produce one
message for two unrelated problems with two unrelated remedies.

Private, like ``_client``. The validated filter shape is a promise; these function signatures are not.
"""

from __future__ import annotations

import copy
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Collection, Iterable, Mapping

__all__ = ["compose", "validate"]

# Field paths §4.2's vector index definition always declares filterable, before `filter_fields`. Named
# here for documentation only: callers pass the set in, so the index definition stays the one authority.
BAKED_IN_FILTER_FIELDS = ("scope", "store_name")


def _reject_operator_keys(value: Any) -> None:
    """Raise if any key at any depth is ``$``-prefixed or not a string (``REQ-E-050``).

    MongoDB's own ``_validate_filter``, byte-identical in
    ``langgraph-checkpoint-mongodb/.../utils.py:46`` and ``langgraph-store-mongodb/.../base.py:49``,
    with one difference: it recurses into ``dict`` values only, and this recurses into lists and tuples
    too. Measured against both copies, ``{"a": [{"$where": "sleep(1000)"}]}`` passes them, and
    ``REQ-E-050`` says *at any depth*.

    §4.3 records why that extension is defense in depth rather than a patched vulnerability: probed on
    MongoDB 8.3.8, a dict inside a list is an equality operand and matches nothing, and every construct
    that would read it as operators is a ``$`` key already rejected here. It is closed because that
    safety is a property of ``$match`` rather than of this function.

    Keys are checked, values are not. A value is data whatever it holds; a key is what MQL dispatches
    on. The string ``"$where"`` in a value position is a five-character string.

    Args:
        value: A filter, or any value reached while walking one.

    Raises:
        ValueError: Naming the offending key.
    """
    if isinstance(value, dict):
        for key, nested in value.items():
            if not isinstance(key, str) or key.startswith("$"):
                raise ValueError(
                    f"strands_mongodb: invalid filter key {key!r}. MongoDB operator keys and "
                    f"non-string keys are not allowed anywhere in a filter, at any depth. A filter is "
                    f"a mapping of field path to exact value, such as {{'metadata.tier': 'gold'}}."
                )
            _reject_operator_keys(nested)
    elif isinstance(value, (list, tuple)):
        for item in value:
            _reject_operator_keys(item)


def _reject_undeclared_fields(caller_filter: Mapping[str, Any], declared: Collection[str]) -> None:
    """Raise if the filter names a path the index did not declare filterable (``REQ-E-049``).

    Atlas does not error on a pre-filter over an undeclared path. It returns unfiltered results (§6.3),
    so the failure this prevents is not an exception a caller could catch: it is a predicate that
    quietly stopped applying, which on the memory path means a scope filter that stopped narrowing.

    Top-level keys only, and that is exact rather than approximate. ``_reject_operator_keys`` has
    already rejected ``$and`` and ``$or``, so no caller filter can place a field path below the top
    level, and a dict value is MQL exact-subdocument equality whose path is the key above it.

    Args:
        caller_filter: A filter that has already passed the operator guard.
        declared: Every path the index declares filterable: ``scope``, ``store_name`` and the config's
            ``filter_fields``. Passed in rather than derived, so §4.2 stays the single authority.

    Raises:
        ValueError: Naming every undeclared path, not only the first, and naming what is available.
    """
    undeclared = sorted(set(caller_filter) - set(declared))
    if not undeclared:
        return

    available = ", ".join(sorted(declared)) or "none"
    raise ValueError(
        f"strands_mongodb: filter field(s) {', '.join(repr(field) for field in undeclared)} are not "
        f"declared filterable on this index, and Atlas returns unfiltered results rather than an error "
        f"for an undeclared field. Filterable here: {available}. Add the field to 'filter_fields' in "
        f"MongoDBConfig and recreate the index to filter on it."
    )


def validate(caller_filter: Mapping[str, Any], *, declared_fields: Iterable[str]) -> None:
    """Check a caller-supplied filter against both guards (``REQ-E-049``, ``REQ-E-050``).

    The operator guard runs first, and the order is part of the contract. ``{"$where": ...}`` is both
    forbidden and undeclared, and a caller told their ``$where`` key is missing from ``filter_fields``
    would reasonably try to declare it.

    Args:
        caller_filter: The filter as the caller supplied it. Not modified.
        declared_fields: Paths the index declares filterable.

    Raises:
        ValueError: From either guard, naming what was wrong.
    """
    _reject_operator_keys(caller_filter)
    _reject_undeclared_fields(caller_filter, tuple(declared_fields))


def compose(
    caller_filter: Mapping[str, Any] | None,
    *,
    scope: str,
    store_name: str,
) -> dict[str, Any]:
    """Compose a caller filter with the scope predicate as a conjunction (``REQ-E-051``).

    ``$and`` rather than a merged dict, and that is the requirement rather than a style preference.
    ``{**scope_predicate, **caller_filter}`` lets a caller key of the same name win, and the key whose
    name is worth overwriting is ``scope``. Under a conjunction the caller's term can only narrow.

    Verified on MongoDB 8.3.8: ``{"$and": [{"scope": {"$eq": "tenant-a"}}, {"scope": "tenant-b"}]}``
    matches 0 documents. A contradictory caller term yields nothing rather than yielding their term,
    which is what makes conjunction sufficient here and lets the tests assert on the emitted dict.

    Does not validate. Callers run :func:`validate` first, because the two have different arguments and
    a caller with no declared-field set to hand should still be able to compose.

    Args:
        caller_filter: The caller's filter, already validated. ``None`` and ``{}`` both add no term.
        scope: This store's scope. Never taken from caller input (``REQ-E-046``); an absent scope
            resolves to a sentinel upstream, never to unfiltered (``REQ-E-048``).
        store_name: This store's name, isolating it from other stores in the same collection.

    Returns:
        A ``$and`` predicate with the scope term first, then the store term, then the caller's filter
        if it has anything in it. Deep-copied, so the caller's dict and the returned predicate share no
        structure in either direction.
    """
    terms: list[dict[str, Any]] = [
        {"scope": {"$eq": scope}},
        {"store_name": {"$eq": store_name}},
    ]
    if caller_filter:
        # Deep, not shallow. A caller who mutates a nested value after composing must not be able to
        # alter a query that is already in flight.
        terms.append(copy.deepcopy(dict(caller_filter)))
    return {"$and": terms}
