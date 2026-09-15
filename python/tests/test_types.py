"""Acceptance tests for the public configuration, query and result types.

Covers ``AT-056`` (``REQ-E-056``) and ``AT-056a`` through ``AT-056e``, which hold the config surface
that ``REQ-E-001`` and ``REQ-E-002`` are promises about.

Most of what ``types.py`` promises is unobservable at runtime, and that is not a gap in the tests. A
``Required`` key and a narrow ``Literal`` are instructions to a type checker; the interpreter ignores
both. So the tests split by who enforces the property: ``dataclasses.fields`` and ``__annotations__``
for what the interpreter knows, and a real ``mypy`` run for what only it knows.

The split is sharper here than anywhere else in the suite because of one measured fact. Under
``from __future__ import annotations``, which this package and the SDK both use everywhere,
``TypedDict`` cannot see ``Required`` at all: ``MemoryStoreConfig.__required_keys__`` is an **empty**
frozenset on the installed 1.54.0, with ``name`` sitting in ``__optional_keys__`` despite being
declared ``Required[str]``. Asserting ``"name" in __required_keys__`` would therefore fail against a
correct implementation, and the obvious repair -- dropping the future import from our module -- would
fix our own keys, leave the inherited ``name`` still unseen, and break the module on import (see
``AT-056c``). The requirement is real and mypy is what enforces it.
"""

from __future__ import annotations

import dataclasses
import subprocess
import sys
import textwrap
from typing import TYPE_CHECKING, get_args

import pytest
from strands.memory import MemoryStoreConfig

from strands_mongodb.types import (
    DEFAULT_MAX_SEARCH_RESULTS,
    DEFAULT_OVERSAMPLING_FACTOR,
    RESERVED_METADATA_KEYS,
    MongoDBAddResult,
    MongoDBConfig,
    MongoDBMemoryStoreConfig,
    MongoDBSearchQuery,
    ResolvedSearchType,
    SearchType,
)

if TYPE_CHECKING:
    from collections.abc import Callable


class TestAddResultReportsWhatTheWriteDid:
    """AT-056 / REQ-E-056 — ``add`` returns a dataclass, not a bare count or an id list."""

    def test_it_is_a_dataclass_carrying_the_three_declared_fields_in_order(self) -> None:
        """Field order is part of the shape, because a dataclass is positionally constructible.

        ``MongoDBAddResult(["a"], 1, 0)`` is a call a caller can write, so reordering the fields is a
        silent breaking change that no keyword-only test would catch.
        """
        assert dataclasses.is_dataclass(MongoDBAddResult)
        assert [f.name for f in dataclasses.fields(MongoDBAddResult)] == ["ids", "inserted", "duplicates"]

    def test_it_round_trips_the_values_it_was_given(self) -> None:
        """The literal from the task description, asserted as written."""
        result = MongoDBAddResult(ids=["6512", "6513"], inserted=1, duplicates=0)

        assert result.ids == ["6512", "6513"]
        assert result.inserted == 1
        assert result.duplicates == 0

    def test_duplicates_has_no_default_so_a_caller_cannot_be_told_zero_by_omission(self) -> None:
        """``duplicates`` is the field ``REQ-E-042`` exists to surface (§6.2, DoD 8).

        A default of ``0`` would let a code path that never counted duplicates construct a result
        claiming there were none. Every construction site has to answer the question.
        """
        by_name = {f.name: f for f in dataclasses.fields(MongoDBAddResult)}

        assert by_name["duplicates"].default is dataclasses.MISSING
        assert by_name["duplicates"].default_factory is dataclasses.MISSING


class TestMemoryStoreConfigExtendsTheSdkConfig:
    """AT-056a — the store config is the SDK's config plus MongoDB's fields."""

    def test_it_carries_every_key_the_sdk_config_declares(self) -> None:
        """``MemoryManager`` reads ``name``, ``description``, ``max_search_results``, ``writable``
        and ``extraction``. A config that dropped one would leave the store unroutable.

        Asserted through ``__annotations__``, which ``TypedDict`` merges across bases, because a
        ``TypedDict`` subclass does not keep its base in ``__mro__`` and ``issubclass`` is therefore
        not available to ask this question.
        """
        assert set(MemoryStoreConfig.__annotations__) <= set(MongoDBMemoryStoreConfig.__annotations__)

    def test_it_adds_the_mongodb_fields_from_plan_8_1(self) -> None:
        """The six fields beyond the SDK's, named so a rename is deliberate."""
        added = set(MongoDBMemoryStoreConfig.__annotations__) - set(MemoryStoreConfig.__annotations__)

        assert added == {"config", "collection", "scope", "filter", "min_score", "max_score"}

    def test_mypy_requires_both_name_and_config(
        self, run_mypy: Callable[[str], subprocess.CompletedProcess[str]]
    ) -> None:
        """The half of ``AT-056a`` the interpreter cannot answer.

        ``name`` is inherited as ``Required[str]`` from the SDK and ``config`` is declared
        ``Required`` here, so a literal missing either is an error. Both are asserted in one run
        because a checker that had lost sight of the base class entirely would still flag ``config``.
        """
        result = run_mypy(
            """
            from strands_mongodb.types import MongoDBMemoryStoreConfig

            no_name: MongoDBMemoryStoreConfig = {"config": {"database": "agents"}}
            no_config: MongoDBMemoryStoreConfig = {"name": "facts"}
            """
        )

        assert result.returncode == 1, result.stdout
        assert 'Missing key "name" for TypedDict "MongoDBMemoryStoreConfig"' in result.stdout, result.stdout
        assert 'Missing key "config" for TypedDict "MongoDBMemoryStoreConfig"' in result.stdout, result.stdout

    def test_mypy_accepts_a_complete_literal(self, run_mypy: Callable[[str], subprocess.CompletedProcess[str]]) -> None:
        """The positive case, without which the test above passes against a config that rejects
        everything."""
        result = run_mypy(
            """
            from strands_mongodb.types import MongoDBMemoryStoreConfig

            config: MongoDBMemoryStoreConfig = {
                "name": "facts",
                "max_search_results": 5,
                "config": {"database": "agents", "connection_string": "mongodb://localhost"},
                "scope": "user:1",
            }
            """
        )

        assert result.returncode == 0, result.stdout


class TestDatabaseIsTheOneMandatoryConnectionField:
    """AT-056b — the Task 1 demo, as a test rather than a transcript."""

    def test_the_config_declares_plan_8_1_s_ten_fields_plus_the_two_task_4_justified(self) -> None:
        """Plan §8.1 fixes this field set, so it is asserted rather than left to review.

        The plan's wording is that the config is reproduced verbatim, which makes any addition here a
        deliberate departure rather than an oversight. A new key is cheap to add and impossible to
        remove once a caller sets it, so the list is worth spelling out.

        Two departures, both from ``REQ-E-067``. ``embedding_dimensions`` and ``similarity`` are what a
        manual vector index needs at creation time, and §5.2 promotes the manual path to the primary
        tested one because an ``autoEmbed`` index is rejected at creation on every deployment CI can
        reach. Without them the package can build a working vector index nowhere.
        """
        assert set(MongoDBConfig.__annotations__) == {
            "database",
            "client",
            "connection_string",
            "client_args",
            "ensure_indexes",
            "search_type",
            "embedding_model",
            "filter_fields",
            "vector_index_name",
            "text_index_name",
            "embedding_dimensions",
            "similarity",
        }

    def test_the_two_added_fields_are_optional_and_typed(
        self, run_mypy: Callable[[str], subprocess.CompletedProcess[str]]
    ) -> None:
        """The zero-configuration path stays the Atlas one: a caller who sets neither field gets the
        ``autoEmbed`` mode and never learns these exist. ``embedding_dimensions`` is an ``int``, and a
        string there is the mistake worth catching, since the server's own answer to it arrives after
        the collection and five other indexes have been created.
        """
        result = run_mypy(
            """
            from strands_mongodb.types import MongoDBConfig

            default: MongoDBConfig = {"database": "agents"}
            manual: MongoDBConfig = {
                "database": "agents",
                "embedding_dimensions": 1024,
                "similarity": "cosine",
            }
            wrong: MongoDBConfig = {"database": "agents", "embedding_dimensions": "1024"}
            """
        )

        assert result.returncode == 1, result.stdout
        assert result.stdout.count("error:") == 1, result.stdout
        assert "embedding_dimensions" in result.stdout, result.stdout

    def test_mypy_rejects_a_config_literal_without_a_database(
        self, run_mypy: Callable[[str], subprocess.CompletedProcess[str]]
    ) -> None:
        """A config with a connection string and no database names a server, not a place to write.

        Runtime detection is not available: ``__required_keys__`` is empty under postponed
        annotations, so nothing raises when the key is absent. The failure would surface as a
        ``KeyError`` inside the first query instead.
        """
        result = run_mypy(
            """
            from strands_mongodb.types import MongoDBConfig

            config: MongoDBConfig = {"connection_string": "mongodb://localhost"}
            """
        )

        assert result.returncode == 1, result.stdout
        assert 'Missing key "database" for TypedDict "MongoDBConfig"' in result.stdout, result.stdout

    def test_mypy_rejects_a_misspelled_optional_key(
        self, run_mypy: Callable[[str], subprocess.CompletedProcess[str]]
    ) -> None:
        """``total=False`` makes every other key optional, which is not the same as unchecked.

        This is the property that makes the config worth typing at all: a typo in an optional key is
        otherwise a setting that silently does nothing.
        """
        result = run_mypy(
            """
            from strands_mongodb.types import MongoDBConfig

            config: MongoDBConfig = {"database": "agents", "ensure_index": True}
            """
        )

        assert result.returncode == 1, result.stdout
        assert "ensure_index" in result.stdout, result.stdout


class TestTheModuleImportsWithoutADriver:
    """AT-056c — annotating a config must not construct one.

    Blocking ``pymongo`` outright is a stronger statement than checking ``sys.modules``: it fails at
    the point of import rather than reporting on collection order, and it is the environment a
    ``strands-agents``-only resolution would produce if either extra ever stopped pinning the driver.
    """

    def test_importing_the_types_module_with_pymongo_blocked_succeeds(self) -> None:
        """Two failure modes, one assertion.

        Moving ``AsyncMongoClient`` out of ``TYPE_CHECKING`` makes the guarded import fire and raises
        the ``missing_extra`` message. Dropping ``from __future__ import annotations`` raises
        ``NameError`` from the class body instead, because ``TypedDict`` evaluates its annotations
        eagerly to compute ``__required_keys__`` -- measured on 3.14, where PEP 649 otherwise defers
        annotations and would have hidden this.
        """
        source = """
            import sys


            class Blocker:
                def find_spec(self, fullname, path=None, target=None):
                    if fullname == "pymongo" or fullname.startswith("pymongo."):
                        raise ImportError(f"No module named {fullname!r}", name=fullname)
                    return None


            sys.meta_path.insert(0, Blocker())

            from strands_mongodb.types import MongoDBConfig

            print(MongoDBConfig.__name__)
            print("pymongo" in sys.modules)
            """
        result = subprocess.run(
            [sys.executable, "-c", textwrap.dedent(source)],
            capture_output=True,
            text=True,
            check=False,
        )

        assert result.returncode == 0, result.stderr
        assert result.stdout.splitlines() == ["MongoDBConfig", "False"], result.stdout


class TestTheSearchTierVocabulary:
    """AT-056d — two literals, because asking for a tier and reporting one are different domains."""

    def test_the_requestable_tiers_are_the_three_that_v0_1_0_runs(self) -> None:
        """Plan §8.1: a ``Literal`` in the config is a promise the caller can typecheck against, so
        it holds only values that actually run. ``hybrid`` arrives with SRCH-6 and ``regex`` with
        SRCH-5, both in v0.2.0, and widening a ``Literal`` is backwards compatible.

        Asserted against the named alias rather than the field annotation, which is a string under
        postponed annotations and would need resolving before ``get_args`` saw anything.
        """
        assert get_args(SearchType) == ("auto", "vector", "text")

    def test_the_reportable_tiers_are_the_two_that_can_answer_a_v0_1_0_query(self) -> None:
        """``REQ-E-054`` puts the answering tier in ``_search_type`` so a silent fallback is visible.

        Plan §6.4 lists four values for that key. Two of them cannot occur in v0.1.0: ``hybrid`` is
        out of scope (§10) and ``regex`` is reachable only through a ``search_type`` value that
        ``SearchType`` does not accept. Listing them anyway would make a caller matching on this key
        handle branches that never run, which is the same mistake plan §8.1 rejects for the config.
        """
        assert get_args(ResolvedSearchType) == ("vector", "text")

    def test_mypy_rejects_a_tier_that_v0_1_0_does_not_run(
        self, run_mypy: Callable[[str], subprocess.CompletedProcess[str]]
    ) -> None:
        """The point of the narrow literal: ``hybrid`` fails at the config site, not at query time."""
        result = run_mypy(
            """
            from strands_mongodb.types import MongoDBConfig

            config: MongoDBConfig = {"database": "agents", "search_type": "hybrid"}
            """
        )

        assert result.returncode == 1, result.stdout
        assert "hybrid" in result.stdout, result.stdout


class TestTheSearchQueryWidensTheProtocolQuery:
    """AT-056e — the pre-computed-vector path (``REQ-E-074``, plan §3.3(b))."""

    def test_it_declares_the_fields_the_widened_query_carries(self) -> None:
        """`Storage.search` takes one argument, so anything a caller wants to say about a query has
        to travel inside it: the text, a pre-computed embedding, a filter, and the two dials.
        """
        assert set(MongoDBSearchQuery.__annotations__) == {
            "text",
            "vector",
            "filter",
            "limit",
            "oversampling_factor",
        }

    def test_every_field_is_optional_because_the_valid_combinations_are_not_expressible(self) -> None:
        """A query needs ``text`` or ``vector`` and not both, which no ``TypedDict`` can say.

        Marking either ``Required`` would forbid the other path. The constraint is checked at runtime
        by the search implementation instead, and this pins that the type deliberately does not try.
        """
        assert MongoDBSearchQuery.__required_keys__ == frozenset()

    def test_mypy_accepts_a_vector_only_query(
        self, run_mypy: Callable[[str], subprocess.CompletedProcess[str]]
    ) -> None:
        """``REQ-E-074``'s entry point, checked at the type level."""
        result = run_mypy(
            """
            from strands_mongodb.types import MongoDBSearchQuery

            query: MongoDBSearchQuery = {"vector": [0.1, 0.2], "limit": 5}
            """
        )

        assert result.returncode == 0, result.stdout


class TestTheSharedConstants:
    """AT-056f — values other modules must not respell."""

    def test_the_four_reserved_metadata_keys_are_the_ones_the_readme_documents(self) -> None:
        """``REQ-E-040`` returns them on every entry and ``REQ-E-057`` resolves collisions against
        them, so the two requirements have to agree on one set.
        """
        assert RESERVED_METADATA_KEYS == frozenset({"_relevance_score", "_id", "_search_type", "_scope"})

    def test_the_result_default_matches_both_shipped_stores(self) -> None:
        """Plan §6.4: ``FileMemoryStore`` and ``BedrockKnowledgeBaseStore`` both default to 10.

        Behavioural parity across stores is the reason for the number, so it is asserted rather than
        left as a literal in ``search``.
        """
        assert DEFAULT_MAX_SEARCH_RESULTS == 10

    def test_the_oversampling_default_matches_the_stage_builder_it_feeds(self) -> None:
        """``pymongo_search_utils.vector_search_stage`` defaults ``oversampling_factor`` to 10 and
        computes ``numCandidates = top_k * oversampling_factor`` (§6.9).

        ``REQ-E-072`` requires us to derive the candidate count rather than pass a constant. Matching
        their default means our derived count equals theirs for a caller who sets nothing.
        """
        assert DEFAULT_OVERSAMPLING_FACTOR == 10


class TestTheModuleDeclaresItsSurface:
    """Every name the tests above import is public, and nothing else is."""

    def test_all_lists_exactly_the_exported_names(self) -> None:
        """A type module with no ``__all__`` exports its imports too, so ``MemoryStoreConfig`` and
        ``TypedDict`` would read as part of this package's surface.
        """
        import strands_mongodb.types as types_module

        assert types_module.__all__ == [
            "DEFAULT_MAX_SEARCH_RESULTS",
            "DEFAULT_OVERSAMPLING_FACTOR",
            "MongoDBAddResult",
            "MongoDBConfig",
            "MongoDBMemoryStoreConfig",
            "MongoDBSearchQuery",
            "RESERVED_METADATA_KEYS",
            "ResolvedSearchType",
            "SearchType",
            "VectorSimilarity",
        ]

    @pytest.mark.parametrize("name", ["MongoDBConfig", "MongoDBAddResult", "SearchType"])
    def test_each_exported_name_resolves(self, name: str) -> None:
        """``__all__`` entries that do not exist fail only on ``import *``, which nothing here does."""
        import strands_mongodb.types as types_module

        assert hasattr(types_module, name)
