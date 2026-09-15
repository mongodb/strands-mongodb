"""Caller-filter validation and scope composition: ``REQ-E-049`` through ``REQ-E-051``.

`SEC-1`, and premortem **P-1**'s most likely mechanism. Isolation here is a predicate in a query
rather than a database boundary (§11.3), so a filter that widens the read scope, or one that silently
fails to narrow it, leaks another customer's memories and looks like a relevance quirk rather than a
breach.

Pure functions over dicts, so all of this runs in the mock tier. The one thing a dict cannot tell us is
what the *server* does with the dict, and two of those questions were settled by probing MongoDB 8.3.8
directly rather than by reasoning: whether a list-nested operator is an operator, and whether a
conjunction can be widened. Both answers are recorded in ``design-delta.md`` §4.3, and the tests below
assert the shape we emit rather than re-probing the server on every run.
"""

from __future__ import annotations

from typing import Any

import pytest

from strands_mongodb import _filter

# The paths §4.2's index definition always declares, before any caller-supplied `filter_fields`.
BAKED_IN = ("scope", "store_name")


class TestOperatorKeysAreRejectedAtAnyDepth:
    """AT-050a, AT-050b, AT-050c / REQ-E-050 — the guard copied from MongoDB, and the line added to it.

    Rejecting keys rather than values is the reference implementation's choice and it is the right one:
    a value is data no matter what it contains, while a key is the thing MQL dispatches on. ``$where``
    as a *value* is the string ``"$where"``; as a *key* it is server-side JavaScript.
    """

    @pytest.mark.parametrize(
        "operator",
        ["$where", "$expr", "$function", "$accumulator", "$or", "$and", "$nor", "$jsonSchema"],
    )
    def test_a_top_level_operator_is_rejected_by_name(self, operator: str) -> None:
        """AT-050a — the message names the key, so the caller knows which of their keys was refused."""
        with pytest.raises(ValueError, match=r"\$"):
            _filter.validate({operator: "anything"}, declared_fields=BAKED_IN)

    def test_the_message_names_the_offending_key_itself(self) -> None:
        """A guard that says `invalid filter` and not which key sends the caller bisecting their dict."""
        with pytest.raises(ValueError) as caught:
            _filter.validate({"$where": "sleep(1000)"}, declared_fields=BAKED_IN)

        assert "$where" in str(caught.value)

    def test_an_operator_nested_one_level_down_is_rejected(self) -> None:
        """AT-050b — recursion is the whole point.

        A top-level-only check is bypassed by nesting one level, which is the plan's own note on this
        guard. ``{"a": {"$ne": None}}`` is the canonical example because it is also the most useful
        thing an attacker can write: matching every document where ``a`` is anything at all.
        """
        with pytest.raises(ValueError, match=r"\$ne"):
            _filter.validate({"a": {"$ne": None}}, declared_fields=("a",))

    def test_an_operator_nested_three_levels_down_is_rejected(self) -> None:
        """Depth is unbounded in the requirement, so it is unbounded here."""
        with pytest.raises(ValueError, match=r"\$gt"):
            _filter.validate({"a": {"b": {"c": {"$gt": 1}}}}, declared_fields=("a",))

    def test_an_operator_inside_a_list_is_rejected(self) -> None:
        """The line this package adds to MongoDB's guard.

        Both MongoDB copies recurse into ``dict`` values only, so
        ``{"a": [{"$where": "sleep(1000)"}]}`` passes them. Verified, not assumed. ``REQ-E-050`` says
        *at any depth*, and a list is a depth.

        This is defense in depth rather than a patched hole, and the test says so on purpose. Probed
        against MongoDB 8.3.8, that filter matches 0 of 2 documents in a ``$match``: a dict inside a
        list is an equality operand, not an operator position, and every construct that would read it
        as operators is a ``$`` key already rejected. The reason to close it anyway is that the property
        making it safe belongs to ``$match``, not to this function, and the same dict handed to a
        different stage would not inherit it.
        """
        with pytest.raises(ValueError, match=r"\$where"):
            _filter.validate({"a": [{"$where": "sleep(1000)"}]}, declared_fields=("a",))

    def test_an_operator_inside_a_nested_list_is_rejected(self) -> None:
        """Lists inside lists, since ``{"a": [[{"$expr": {}}]]}`` also passes the reference guard."""
        with pytest.raises(ValueError, match=r"\$expr"):
            _filter.validate({"a": [[{"$expr": {}}]]}, declared_fields=("a",))

    def test_an_operator_inside_a_tuple_is_rejected(self) -> None:
        """A tuple reaches BSON as an array, so it is the same exposure spelled differently.

        Worth its own test rather than folding into the list case: ``isinstance(value, list)`` is the
        obvious implementation and it misses this.
        """
        with pytest.raises(ValueError, match=r"\$where"):
            _filter.validate({"a": ({"$where": "x"},)}, declared_fields=("a",))

    @pytest.mark.parametrize("key", [1, 2.5, None, True, (1, 2)])
    def test_a_non_string_key_is_rejected(self, key: Any) -> None:
        """AT-050c — non-string keys, which BSON cannot encode anyway.

        ``bson.encode({1: "x"})`` raises ``InvalidDocument: documents must have only string keys``, so
        this check is about *where* the failure lands rather than whether one happens. Ours names the
        caller's filter; BSON's arrives from inside the driver mid-query, after the scope predicate has
        already been composed around it.
        """
        with pytest.raises(ValueError):
            _filter.validate({key: "x"}, declared_fields=BAKED_IN)

    def test_a_non_string_key_nested_in_a_dict_is_rejected(self) -> None:
        """The recursion has to carry the key-type check with it, not only the ``$`` check."""
        with pytest.raises(ValueError):
            _filter.validate({"a": {1: "x"}}, declared_fields=("a",))

    def test_a_list_of_plain_values_is_allowed(self) -> None:
        """The recursion has to walk lists *and* let clean ones through.

        Found by branch coverage rather than by design: every list in the tests above raises, so the
        path where the loop finishes normally was unexercised. It is not an edge case.
        ``{"tier": ["gold", "silver"]}`` is ordinary MQL, matching a document whose ``tier`` array equals
        that list, and a guard that rejected it would break a documented filter shape.
        """
        _filter.validate({"tier": ["gold", "silver"]}, declared_fields=("tier",))
        _filter.validate({"tier": []}, declared_fields=("tier",))
        _filter.validate({"tier": [{"nested": "ok"}]}, declared_fields=("tier",))

    def test_a_dollar_sign_that_is_not_a_prefix_is_allowed(self) -> None:
        """``startswith``, not ``in``. A field legitimately named ``price$usd`` is not an operator.

        The negative half of the guard. A check written as ``"$" in key`` passes every test above and
        rejects valid documents, which is the failure mode nobody notices until a user reports it.
        """
        _filter.validate({"price$usd": 10}, declared_fields=("price$usd",))

    def test_a_benign_operator_is_rejected_too_and_that_is_the_requirement(self) -> None:
        """``REQ-E-050`` has no allow-list, so ``$gt`` goes the way of ``$where``.

        Pinned as a test because it is the constraint most likely to be "fixed" by someone who reads
        the rejection as overzealous. A caller filter in v0.1.0 is a flat map of path to exact value.
        Widening it to a comparison-operator allow-list is a v0.2.0 decision with its own threat model,
        and this test is what makes that a decision rather than a drive-by.
        """
        with pytest.raises(ValueError, match=r"\$gt"):
            _filter.validate({"age": {"$gt": 5}}, declared_fields=("age",))


class TestUndeclaredFieldsAreRejectedBeforeQuerying:
    """AT-049 / REQ-E-049 — the check that exists because Atlas does not do it.

    Plan §6.3: a query pre-filtering on a path the index did not declare does not error. It returns
    unfiltered results. So the failure is not an exception a caller can catch, it is a filter that
    quietly stopped applying, which on the memory path means one customer's scope predicate stopped
    narrowing.
    """

    def test_an_undeclared_field_raises_naming_the_field(self) -> None:
        """AT-049, with the exact case ``tasks.md`` specifies."""
        with pytest.raises(ValueError, match=r"metadata\.foo"):
            _filter.validate({"metadata.foo": "x"}, declared_fields=("scope", "store_name"))

    def test_the_message_names_what_was_declared_as_well(self) -> None:
        """Naming only the rejected field leaves the caller guessing what they may filter on.

        The remedy for this error is to add the path to ``filter_fields`` and recreate the index, and
        the message is the only place a caller learns that the option exists.
        """
        with pytest.raises(ValueError) as caught:
            _filter.validate({"metadata.foo": "x"}, declared_fields=("scope", "store_name"))

        message = str(caught.value)
        assert "filter_fields" in message
        assert "scope" in message and "store_name" in message

    def test_a_declared_field_passes(self) -> None:
        """The positive half, including a caller-supplied path alongside the baked-in ones."""
        _filter.validate({"metadata.tier": "gold"}, declared_fields=("scope", "store_name", "metadata.tier"))

    def test_the_baked_in_paths_are_filterable_without_being_configured(self) -> None:
        """``scope`` and ``store_name`` are declared by §4.2's index definition, not by the caller.

        This is the case ``REQ-E-049``'s literal wording gets wrong, and §4.3 records the correction.
        Validating against ``filter_fields`` alone would reject a filter that Atlas applies correctly.
        """
        _filter.validate({"scope": "tenant-a"}, declared_fields=("scope", "store_name"))
        _filter.validate({"store_name": "facts"}, declared_fields=("scope", "store_name"))

    def test_every_undeclared_field_is_named_not_just_the_first(self) -> None:
        """A caller who got three paths wrong should learn that in one round trip, not three.

        Distinctive multi-character paths on purpose. Asserting that ``"a"`` appears in an error message
        proves nothing, since almost any English sentence contains it.
        """
        with pytest.raises(ValueError) as caught:
            _filter.validate(
                {"metadata.tier": 1, "region": 2, "created_at": 3},
                declared_fields=("scope",),
            )

        message = str(caught.value)
        assert "metadata.tier" in message
        assert "region" in message
        assert "created_at" in message

    def test_only_top_level_keys_are_treated_as_field_paths(self) -> None:
        """``{"metadata": {"tier": "gold"}}`` filters on ``metadata``, not on ``metadata.tier``.

        That is MQL's own reading: a dict value is exact-subdocument equality. Because the operator
        guard rejects ``$and`` and ``$or``, no caller filter can put a field path anywhere but the top
        level, so this needs no path-walking and asserting it keeps that reasoning honest.
        """
        _filter.validate({"metadata": {"tier": "gold"}}, declared_fields=("metadata",))

        with pytest.raises(ValueError, match="metadata"):
            _filter.validate({"metadata": {"tier": "gold"}}, declared_fields=("metadata.tier",))

    def test_an_empty_filter_is_accepted(self) -> None:
        """``{}`` names no field, so there is nothing to reject.

        The realistic source is a caller passing through an unset option. Raising here would make the
        absence of a filter an error.
        """
        _filter.validate({}, declared_fields=())

    def test_the_operator_guard_runs_before_the_declared_field_guard(self) -> None:
        """Order matters for the message, and ``{"$where": ...}`` is undeclared as well as forbidden.

        A caller told their ``$where`` key is *not in filter_fields* would reasonably try declaring it.
        The security rejection has to be the one they see.
        """
        with pytest.raises(ValueError) as caught:
            _filter.validate({"$where": "sleep(1000)"}, declared_fields=())

        message = str(caught.value)
        assert "$where" in message
        assert "filter_fields" not in message


class TestScopeCannotBeWidenedByACallerFilter:
    """AT-051 / REQ-E-051 — asserted on the emitted predicate, per ``tasks.md``.

    Probed against MongoDB 8.3.8 so the shape assertion below stands on a measured fact rather than on
    MQL folklore: ``{"$and": [{"scope": {"$eq": "tenant-a"}}, {"scope": "tenant-b"}]}`` matches 0
    documents. A conjunction with a contradictory term returns nothing; it does not return the caller's
    term. That is what makes composition-by-``$and`` sufficient, and it is why these tests can assert on
    the dict instead of round-tripping every case through a server.
    """

    def test_the_scope_predicate_is_always_present(self) -> None:
        """The base case: no caller filter at all still narrows."""
        composed = _filter.compose(None, scope="tenant-a", store_name="facts")

        assert {"scope": {"$eq": "tenant-a"}} in composed["$and"]
        assert {"store_name": {"$eq": "facts"}} in composed["$and"]

    def test_a_caller_filter_is_conjoined_rather_than_merged(self) -> None:
        """Merging into one dict is the bug. ``{**scope_pred, **caller}`` lets a duplicate key win.

        Under ``$and`` the caller's term is an additional constraint. Under a merge it *replaces* the
        scope term, and the store starts reading every customer's documents.
        """
        composed = _filter.compose({"metadata.tier": "gold"}, scope="tenant-a", store_name="facts")

        assert {"scope": {"$eq": "tenant-a"}} in composed["$and"]
        assert {"metadata.tier": "gold"} in composed["$and"]

    def test_a_caller_filter_naming_scope_cannot_replace_the_scope_predicate(self) -> None:
        """The attack, spelled as plainly as it would arrive.

        Both terms survive. The server then matches nothing, which is the correct outcome: a caller
        asking for another scope gets no documents rather than that scope's documents.
        """
        composed = _filter.compose({"scope": "tenant-b"}, scope="tenant-a", store_name="facts")

        assert {"scope": {"$eq": "tenant-a"}} in composed["$and"]
        assert {"scope": "tenant-b"} in composed["$and"]

    def test_an_empty_caller_filter_adds_no_term(self) -> None:
        """``{}`` in a ``$and`` is a match-everything term, so it is dropped rather than appended.

        Harmless to MongoDB and not harmless to read: an empty clause inside the predicate that
        enforces isolation invites exactly one misreading, that something in there matches everything.
        """
        composed = _filter.compose({}, scope="tenant-a", store_name="facts")

        assert composed["$and"] == [{"scope": {"$eq": "tenant-a"}}, {"store_name": {"$eq": "facts"}}]

    def test_the_scope_term_comes_first(self) -> None:
        """Order is asserted because §4.3 fixes it, and because it is what a reader checks first.

        No MQL semantics depend on it. A human scanning a logged pipeline for the isolation predicate
        does, and putting it anywhere but position 0 makes that scan a search.
        """
        composed = _filter.compose({"metadata.tier": "gold"}, scope="tenant-a", store_name="facts")

        assert composed["$and"][0] == {"scope": {"$eq": "tenant-a"}}

    def test_the_caller_filter_is_not_mutated(self) -> None:
        """The caller's dict is theirs. Composing must not write the scope into it.

        A caller reusing one filter dict across two stores with different scopes would otherwise carry
        the first store's scope into the second query.
        """
        caller = {"metadata.tier": "gold"}

        _filter.compose(caller, scope="tenant-a", store_name="facts")

        assert caller == {"metadata.tier": "gold"}

    def test_the_composed_predicate_shares_no_structure_with_the_caller_filter(self) -> None:
        """Copied, not aliased. A caller mutating their dict afterwards must not alter a live query.

        Same class of bug as the one above and it needs its own assertion: a shallow ``list(...)``
        append passes the mutation test while still holding the caller's object by reference.
        """
        caller: dict[str, Any] = {"metadata.tier": "gold"}
        composed = _filter.compose(caller, scope="tenant-a", store_name="facts")

        caller["metadata.tier"] = "bronze"

        assert {"metadata.tier": "gold"} in composed["$and"]

    def test_the_sentinel_scope_composes_like_any_other(self) -> None:
        """``REQ-E-048`` — absent scope resolves to a sentinel, never to unfiltered.

        ``compose`` does not choose the sentinel, Task 8 does. What is asserted here is that it has no
        special case that would let one through as an absent term: a ``None`` scope must not silently
        drop the predicate.
        """
        composed = _filter.compose(None, scope="__no_scope__", store_name="facts")

        assert composed["$and"][0] == {"scope": {"$eq": "__no_scope__"}}
