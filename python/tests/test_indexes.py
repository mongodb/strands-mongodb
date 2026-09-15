"""Index specs, idempotent ensure/verify and readiness polling: ``REQ-E-060`` through ``REQ-E-068``.

Three tiers, because the module has three kinds of claim and they are verifiable in different places.
What the package *emits* is a dict and runs unmocked in the unit tier. What a **plain MongoDB** does
with an ordinary index runs in the contract tier. What **mongot** does with a search index, including
the asynchronous build that makes created and queryable two different states, runs in the integration
tier.

Nothing here re-probes the server for facts already settled. Design delta §4.2 records what Task 4
measured against MongoDB 8.3.8, including the two rows of the design it contradicted, and the tests
below assert the behaviour that follows from those measurements. The ones that do hit a deployment are
the ones where a passing mock would prove nothing: option conflicts, the missing-namespace asymmetry,
and the build states.
"""

from __future__ import annotations

import asyncio
import inspect
import logging
from typing import TYPE_CHECKING, Any

import pytest

from strands_mongodb import _indexes

if TYPE_CHECKING:
    from collections.abc import AsyncIterator, Iterable, Mapping, Sequence

    from strands_mongodb.types import MongoDBConfig, VectorSimilarity

# Every index this package creates on the memory collection, by §6.8 row number.
MEMORY_ROWS = ("3", "4", "7")


class TestVectorModeIsResolvedFromTheConfig:
    """AT-067 / REQ-E-067 — the two fields added to ``MongoDBConfig``, and the combinations that raise.

    Mode selection mirrors ``pymongo_search_utils._check_param_config``'s exactly-one-mode rule without
    importing it. The reason the manual mode has to be configurable at all is measured rather than
    argued: an ``autoEmbed`` index is rejected at **creation** on Atlas local, so the path CI can test
    is the manual one, and a manual vector index cannot be created without ``numDimensions`` and
    ``similarity``.
    """

    def test_an_empty_config_selects_autoembed_with_the_documented_default(self) -> None:
        """Zero configuration stays the Atlas path, so the default install needs no vector settings."""
        mode = _indexes.vector_mode({"database": "d"})

        assert mode.auto_embed is True
        assert mode.model == _indexes.DEFAULT_EMBEDDING_MODEL
        assert mode.dimensions is None
        assert mode.similarity is None

    def test_the_default_model_is_the_one_the_community_package_ships(self) -> None:
        """Sourced, not chosen. ``strands-mongodb-store`` 0.2.0 defaults to this model (plan §9.3)."""
        assert _indexes.DEFAULT_EMBEDDING_MODEL == "voyage-4-lite"

    def test_an_explicit_model_selects_autoembed_with_that_model(self) -> None:
        mode = _indexes.vector_mode({"database": "d", "embedding_model": "voyage-3-large"})

        assert mode.auto_embed is True
        assert mode.model == "voyage-3-large"

    def test_dimensions_and_similarity_select_the_manual_vector_mode(self) -> None:
        mode = _indexes.vector_mode({"database": "d", "embedding_dimensions": 1024, "similarity": "cosine"})

        assert mode.auto_embed is False
        assert mode.model is None
        assert mode.dimensions == 1024
        assert mode.similarity == "cosine"

    def test_dimensions_without_similarity_raises_and_names_the_missing_field(self) -> None:
        """A vector index needs both. Defaulting the similarity would pick a metric for the caller's
        embeddings, and the wrong metric returns plausible neighbours that are the wrong neighbours."""
        with pytest.raises(ValueError, match="similarity"):
            _indexes.vector_mode({"database": "d", "embedding_dimensions": 1024})

    def test_similarity_without_dimensions_raises(self) -> None:
        with pytest.raises(ValueError, match="embedding_dimensions"):
            _indexes.vector_mode({"database": "d", "similarity": "cosine"})

    def test_setting_both_modes_raises_rather_than_picking_one(self) -> None:
        """The two modes index different fields with different contents, so a silent precedence rule
        would build one index and leave the caller expecting the other."""
        with pytest.raises(ValueError) as caught:
            _indexes.vector_mode(
                {
                    "database": "d",
                    "embedding_model": "voyage-3-large",
                    "embedding_dimensions": 1024,
                    "similarity": "cosine",
                }
            )

        message = str(caught.value)
        assert "embedding_model" in message
        assert "embedding_dimensions" in message

    @pytest.mark.parametrize("similarity", ["cosine", "dotProduct", "euclidean"])
    def test_every_similarity_atlas_accepts_is_accepted_here(self, similarity: VectorSimilarity) -> None:
        mode = _indexes.vector_mode({"database": "d", "embedding_dimensions": 8, "similarity": similarity})

        assert mode.similarity == similarity

    def test_an_unknown_similarity_is_rejected_here_rather_than_by_the_server(self) -> None:
        """Atlas rejects it too, but at index creation, after the collection has been created and the
        other five indexes built. Rejecting it while it is still a dict costs one comparison."""
        # Held as `Any` because `VectorSimilarity` forbids this value, and being unable to write the
        # literal is the *point*: the check exists for configs assembled from environment variables or
        # a JSON file, which reach `vector_mode` having never passed a type checker.
        config: Any = {"database": "d", "embedding_dimensions": 8, "similarity": "l2"}

        with pytest.raises(ValueError, match="cosine"):
            _indexes.vector_mode(config)

    @pytest.mark.parametrize("dimensions", [0, -1, 8193])
    def test_dimensions_outside_the_atlas_bounds_are_rejected_here(self, dimensions: int) -> None:
        """Measured: the server answers ``numDimensions`` outside ``[1..8192]`` with code 8. Same
        reasoning as the similarity check, and ``-1`` specifically is the value plan §6.4 suggests."""
        with pytest.raises(ValueError, match=r"1\.\.8192"):
            _indexes.vector_mode({"database": "d", "embedding_dimensions": dimensions, "similarity": "cosine"})


class TestTheVectorIndexDefinition:
    """AT-071 / REQ-E-071 — filter fields are declared at creation time, in both modes.

    ``REQ-E-071`` is a security requirement wearing an indexing hat. Atlas does not error on a
    pre-filter over an undeclared path; it returns unfiltered results (§6.3), which on the memory path
    is another customer's memories. ``_filter.validate`` is the second guard for the same failure, and
    it can only reject what this definition failed to declare.
    """

    def test_the_autoembed_definition_matches_the_confirmed_wire_shape(self) -> None:
        definition = _indexes.vector_index_definition(_indexes.vector_mode({"database": "d"}))

        assert definition["fields"][0] == {
            "type": "autoEmbed",
            "path": "content",
            "model": "voyage-4-lite",
            "modality": "text",
        }

    def test_the_manual_definition_carries_dimensions_and_similarity(self) -> None:
        definition = _indexes.vector_index_definition(
            _indexes.vector_mode({"database": "d", "embedding_dimensions": 4, "similarity": "euclidean"}),
            vector_field="embedding",
        )

        assert definition["fields"][0] == {
            "type": "vector",
            "path": "embedding",
            "numDimensions": 4,
            "similarity": "euclidean",
        }

    def test_no_definition_ever_emits_the_placeholder_dimension_count(self) -> None:
        """Plan §6.4 describes ``numDimensions: -1`` for the server-side path. That is
        langchain-mongodb's constructor validation, not a wire format: the server answers ``-1`` with
        code 8. ``vector_mode`` cannot produce it, so this asserts the emitted dict as well."""
        configs: tuple[MongoDBConfig, ...] = ({"database": "d"}, {"database": "d", "embedding_model": "m"})
        for config in configs:
            definition = _indexes.vector_index_definition(_indexes.vector_mode(config))

            assert all(field.get("numDimensions") != -1 for field in definition["fields"])

    def test_scope_and_store_name_are_always_declared_filterable(self) -> None:
        """Not optional and not caller supplied. These two are how one collection isolates N stores."""
        definition = _indexes.vector_index_definition(_indexes.vector_mode({"database": "d"}))

        filters = [f["path"] for f in definition["fields"] if f["type"] == "filter"]
        assert filters == ["scope", "store_name"]

    def test_caller_filter_fields_are_appended_after_the_baked_in_two(self) -> None:
        definition = _indexes.vector_index_definition(
            _indexes.vector_mode({"database": "d"}), filter_fields=["metadata.tier", "owner"]
        )

        filters = [f["path"] for f in definition["fields"] if f["type"] == "filter"]
        assert filters == ["scope", "store_name", "metadata.tier", "owner"]

    def test_a_caller_field_that_duplicates_a_baked_in_one_is_declared_once(self) -> None:
        """Atlas rejects a definition with two ``filter`` entries on one path, and a caller listing
        ``scope`` in ``filter_fields`` is asking for something already true rather than making a
        mistake worth failing over."""
        definition = _indexes.vector_index_definition(
            _indexes.vector_mode({"database": "d"}), filter_fields=["scope", "owner"]
        )

        filters = [f["path"] for f in definition["fields"] if f["type"] == "filter"]
        assert filters == ["scope", "store_name", "owner"]

    def test_the_declared_paths_are_readable_without_rebuilding_the_definition(self) -> None:
        """``_filter.validate`` needs the set this definition declared, and §4.3 says the definition
        stays the single authority. That only holds if the set can be read back from here."""
        assert _indexes.declared_filter_fields(["owner"]) == ("scope", "store_name", "owner")

    def test_the_filter_paths_and_the_filter_module_agree_on_the_baked_in_pair(self) -> None:
        """Two modules naming the same two fields is exactly how they drift apart."""
        from strands_mongodb import _filter

        assert _indexes.declared_filter_fields(())[:2] == _filter.BAKED_IN_FILTER_FIELDS


class TestTheFullTextIndexDefinition:
    """§6.8 row 6 — the tier-3 fallback, and the text branch of hybrid in v0.2.0."""

    def test_it_maps_the_content_field_as_a_string_and_nothing_else(self) -> None:
        definition = _indexes.text_index_definition()

        assert definition == {"mappings": {"dynamic": False, "fields": {"content": [{"type": "string"}]}}}

    def test_dynamic_mapping_is_off(self) -> None:
        """``dynamic: True`` indexes every field of every document, including the caller metadata a
        memory carries. That is storage and build time spent on fields no query reads."""
        assert _indexes.text_index_definition()["mappings"]["dynamic"] is False


class TestTheInventoryMatchesPlanSection68:
    """The seven-row index inventory, minus the two rows nothing creates.

    Row 1 is ``_id_``, which the server creates. Rows 5 and 6 are search indexes and live in
    :func:`memory_search_specs`. That leaves one ordinary index on ``storage`` and three on ``memory``.
    """

    def test_the_storage_surface_declares_exactly_its_ttl_index(self) -> None:
        specs = _indexes.storage_specs()

        assert [spec.keys for spec in specs] == [(("expires_at", 1),)]
        assert specs[0].options == {"expireAfterSeconds": 0}

    def test_the_memory_surface_declares_three_ordinary_indexes(self) -> None:
        assert len(_indexes.memory_specs()) == len(MEMORY_ROWS)

    def test_the_dedup_index_carries_the_options_it_exists_for(self) -> None:
        """Row 3. The key list is not the point of this index; ``unique`` is. An ordinary compound
        index over the same three fields satisfies a key-list check exactly and stops nothing, which is
        premortem **P-5** with the index reported present."""
        spec = self._by_keys(("scope", 1), ("store_name", 1), ("content_hash", 1))

        assert spec.options == {
            "unique": True,
            "partialFilterExpression": {"content_hash": {"$exists": True}},
        }

    def test_the_dedup_index_is_partial_so_documents_without_a_hash_do_not_collide(self) -> None:
        """A unique index treats a missing field as ``null``, so without the partial expression the
        second document with no ``content_hash`` collides with the first."""
        spec = self._by_keys(("scope", 1), ("store_name", 1), ("content_hash", 1))

        assert spec.options["partialFilterExpression"] == {"content_hash": {"$exists": True}}

    def test_the_recency_index_sorts_created_at_descending(self) -> None:
        """Row 4. ``-1`` because every read of it is newest-first; an ascending index serves the same
        sort, but the direction here is the one the queries use."""
        spec = self._by_keys(("scope", 1), ("store_name", 1), ("created_at", -1))

        assert spec.options == {}

    def test_the_memory_ttl_index_is_declared_unconditionally(self) -> None:
        """Row 7 is marked optional in §6.8 and is created anyway (§4.2). Conditional on a configured
        ``ttl_seconds`` fails silently: a store that gains a TTL later stamps ``expires_at`` on every
        document and nothing deletes them, with no error to read. A TTL index is inert for documents
        that carry no ``expires_at``, so the unconditional version costs nothing at rest."""
        spec = self._by_keys(("expires_at", 1))

        assert spec.options == {"expireAfterSeconds": 0}

    def test_specs_take_no_arguments_so_the_inventory_cannot_vary_by_caller(self) -> None:
        """``REQ-E-061`` hands a least-privilege operator the exact command list. That list is only
        useful if it is the same list every store asks for."""
        assert _indexes.storage_specs() == _indexes.storage_specs()
        assert _indexes.memory_specs() == _indexes.memory_specs()

    def test_every_name_carries_the_package_prefix(self) -> None:
        """Provenance for whoever reads ``getIndexes()`` on a collection this package shares with an
        application's own indexes. Matching is on keys, so the name only ever appears in a message or
        in a create we issue."""
        for spec in (*_indexes.storage_specs(), *_indexes.memory_specs()):
            assert spec.name.startswith("strands_")

    @staticmethod
    def _by_keys(*keys: tuple[str, int]) -> _indexes.IndexSpec:
        """Return the memory spec with this key list, failing the test if it is absent."""
        for spec in _indexes.memory_specs():
            if spec.keys == keys:
                return spec
        pytest.fail(f"no memory index declared over {keys}")


class TestTheSearchIndexInventory:
    """§6.8 rows 5 and 6, built from the config because both names and one definition come from it."""

    def test_both_search_indexes_are_declared(self) -> None:
        specs = _indexes.memory_search_specs({"database": "d"})

        assert [spec.type for spec in specs] == ["vectorSearch", "search"]

    def test_the_default_index_names_are_the_reference_implementation_names(self) -> None:
        """Sourced rather than chosen: ``vector_index`` from langchain-mongodb
        ``vectorstores.py:219``, ``text_index`` from ``retrievers/parent_document.py:218``. A caller
        pointing this package at a collection langchain already indexed then finds its indexes."""
        specs = _indexes.memory_search_specs({"database": "d"})

        assert [spec.name for spec in specs] == ["vector_index", "text_index"]

    def test_configured_names_override_the_defaults(self) -> None:
        specs = _indexes.memory_search_specs({"database": "d", "vector_index_name": "v", "text_index_name": "t"})

        assert [spec.name for spec in specs] == ["v", "t"]

    def test_the_config_filter_fields_reach_the_vector_definition(self) -> None:
        """The path from ``MongoDBConfig`` to the index is the one ``REQ-E-071`` is about, and a
        definition that is right in isolation and never receives the config is the same bug."""
        specs = _indexes.memory_search_specs({"database": "d", "filter_fields": ["owner"]})

        paths = [f["path"] for f in specs[0].definition["fields"] if f["type"] == "filter"]
        assert paths == ["scope", "store_name", "owner"]

    def test_a_conflicting_vector_config_raises_here_too(self) -> None:
        """The mode check has to run on the path ``initialize()`` actually takes, not only when
        ``vector_mode`` is called directly."""
        with pytest.raises(ValueError, match="embedding_dimensions"):
            _indexes.memory_search_specs({"database": "d", "embedding_model": "m", "embedding_dimensions": 4})


class TestTheCreationCommandsHandedToAnOperator:
    """AT-061 / REQ-E-061 — the command a caller without DDL rights forwards to whoever has them.

    "Naming the index" is not enough on its own: the person who receives the message is not the person
    who read the requirement, and they need something they can run.

    ``db.runCommand`` with the raw server command rather than a shell helper. That is the command
    pymongo itself sends, so it is verifiable from here rather than remembered: ``createIndexes`` and
    ``createSearchIndexes`` are what ``collection.py`` builds. A shell helper's argument order would be
    a detail this package has no way to check, and getting it wrong sends an operator a command that
    fails in their hands.
    """

    def test_an_ordinary_command_is_the_server_command_pymongo_sends(self) -> None:
        spec = _indexes.storage_specs()[0]

        command = spec.creation_command("storage")
        assert command.startswith("db.runCommand(")
        assert '"createIndexes": "storage"' in command
        assert '"expires_at": 1' in command
        assert '"expireAfterSeconds": 0' in command

    def test_an_ordinary_command_names_the_index_it_creates(self) -> None:
        spec = _indexes.storage_specs()[0]

        assert spec.name in spec.creation_command("storage")

    def test_a_search_command_uses_the_search_variant_of_the_command(self) -> None:
        spec = _indexes.memory_search_specs({"database": "d"})[0]

        command = spec.creation_command("memory")
        assert '"createSearchIndexes": "memory"' in command
        assert '"type": "vectorSearch"' in command
        assert '"autoEmbed"' in command

    def test_every_command_is_valid_json_inside_the_call(self) -> None:
        """Runnable means parseable. A repr of a Python dict is not: ``True`` and single quotes are
        both syntax errors in mongosh."""
        import json
        import re

        for spec, collection in (
            (_indexes.memory_specs()[0], "memory"),
            (_indexes.memory_search_specs({"database": "d"})[1], "memory"),
        ):
            command = spec.creation_command(collection)
            body = re.fullmatch(r"db\.runCommand\((.*)\)", command)
            assert body is not None, command
            json.loads(body.group(1))


class FakeSearchIndexCursor:
    """The cursor ``list_search_indexes`` returns, which is async-iterable and not iterable (``MP-002``).

    Stands in for ``AsyncCommandCursor``. Deliberately does **not** implement ``__iter__``: the real
    class does not either, and a fake that did would let a synchronous ``for`` loop pass here and fail
    against a deployment.
    """

    def __init__(self, documents: Iterable[dict[str, Any]]) -> None:
        self._documents = list(documents)

    async def __aiter__(self) -> AsyncIterator[dict[str, Any]]:
        for document in self._documents:
            yield document


class FakeAsyncDatabase:
    """The database half of the fake, which exists for one call: ``create_collection``."""

    def __init__(self, *, name: str = "testdb", create_error: Exception | None = None) -> None:
        self.name = name
        self._create_error = create_error
        self.create_collection_calls: list[tuple[str, dict[str, Any]]] = []

    async def create_collection(self, name: str, **kwargs: Any) -> Any:
        self.create_collection_calls.append((name, kwargs))
        if self._create_error is not None:
            raise self._create_error
        return None


class FakeAsyncCollection:
    """``AsyncCollection`` narrowed to the four methods this module calls (``MP-001``).

    Every method is a coroutine function, which is the property ``MP-001`` checks against the real
    class rather than assuming. The two ``__getattr__``-shaped traps the real class has are absent
    here on purpose: this fake raises ``AttributeError`` for an unknown attribute, so a typo in the
    module under test fails in the unit tier instead of resolving to a sub-collection.
    """

    def __init__(
        self,
        *,
        name: str = "memory",
        indexes: dict[str, dict[str, Any]] | None = None,
        search_states: dict[str, Sequence[list[dict[str, Any]]]] | None = None,
        database: FakeAsyncDatabase | None = None,
    ) -> None:
        self.name = name
        self.database = database if database is not None else FakeAsyncDatabase()
        self._indexes = dict(indexes or {})
        # name -> the documents each successive `list_search_indexes` call returns. The last entry
        # repeats, so a test programs a build's transitions and the poll loop reads them in order.
        self._search_states = {key: list(value) for key, value in (search_states or {}).items()}
        self._search_reads: dict[str, int] = {}
        self.created_indexes: list[Any] = []
        self.created_search_indexes: list[Any] = []

    async def index_information(self) -> dict[str, dict[str, Any]]:
        return {name: dict(spec) for name, spec in self._indexes.items()}

    async def create_indexes(self, models: Sequence[Any]) -> list[str]:
        self.created_indexes.extend(models)
        for model in models:
            document = dict(model.document)
            # Two ways `IndexModel.document` differs from what `index_information` reports, both
            # measured on 4.17.0 against a deployment rather than reasoned about: it holds `key` as a
            # `SON` where the server reports a list of tuples, and it carries the index name as a field
            # where the server uses it as the entry's key and drops it from the body. Normalised here so
            # a create followed by a verify reads the shape the server would have returned.
            name = document.pop("name")
            document["key"] = list(document["key"].items())
            self._indexes[name] = {"v": 2, **document}
        return [model.document["name"] for model in models]

    async def list_search_indexes(self, name: str | None = None) -> FakeSearchIndexCursor:
        states = self._search_states.get(name if name is not None else "*", [[]])
        read = self._search_reads.get(name or "*", 0)
        self._search_reads[name or "*"] = read + 1
        return FakeSearchIndexCursor(states[min(read, len(states) - 1)])

    async def create_search_index(self, model: Any) -> str:
        self.created_search_indexes.append(model)
        name: str = model.document["name"]
        self._search_states.setdefault(name, [[{"name": name, "status": "READY"}]])
        return name


def operation_failure(code: int, message: str = "probed") -> Exception:
    """Build a real ``OperationFailure`` with a server error code, as the driver would raise it."""
    from pymongo.errors import OperationFailure

    return OperationFailure(message, code=code)


def network_failure(message: str = "socket timed out") -> Exception:
    """Build a ``PyMongoError`` that is **not** an ``OperationFailure``, which carries no server code.

    The distinction is the whole reason the module catches two exception types rather than one. A
    connection that dies mid-call never reaches the server, so there is no code to compare against 26
    or 48, and the code-inspecting handler would raise ``AttributeError`` if it ran on one of these.
    """
    from pymongo.errors import NetworkTimeout

    return NetworkTimeout(message)


def raiser(error: BaseException) -> Any:
    """Build a coroutine function that raises, for patching a fake method."""

    async def raise_it(*args: Any, **kwargs: Any) -> Any:
        raise error

    return raise_it


async def bounded(awaitable: Any, seconds: float = 5.0) -> Any:
    """Run an awaitable under a deadline the test owns rather than the one it is testing.

    Two tests below push ``_wait_until_ready`` past its deadline on purpose, against a fake whose
    status never changes. If the deadline check is the thing that is broken, the loop never ends and
    the run stops producing output: no assertion fires, no test is named, and the only symptom is a
    process that has to be killed. Bounding the call turns that back into an ordinary failure.

    The number is unrelated to the ``timeout=0`` under test. It only has to be longer than a correct
    implementation needs, which here is one poll.
    """
    return await asyncio.wait_for(awaitable, timeout=seconds)


def existing(*keys: tuple[str, int], **options: Any) -> dict[str, Any]:
    """Build one entry as ``index_information`` reports it, including the ``v`` nobody asked for."""
    return {"v": 2, "key": list(keys), **options}


class TestOrdinaryIndexesAgainstAFake:
    """REQ-E-060, REQ-E-061, REQ-E-063, REQ-E-064 — the branch logic, without a deployment.

    The contract tier proves the server behaves as design delta §4.2 measured. These tests prove the
    module branches on it correctly, which is a different claim and much cheaper to make exhaustive.
    """

    async def test_a_missing_index_is_created_when_creation_is_allowed(self) -> None:
        collection: Any = FakeAsyncCollection()

        await _indexes.ensure(collection, ordinary=_indexes.storage_specs(), create=True)

        assert len(collection.created_indexes) == 1

    async def test_all_missing_indexes_are_created_in_one_call(self) -> None:
        """``create_indexes`` takes a list, and three round trips where one would do is three chances
        for a partial result to leave the collection half indexed."""
        collection: Any = FakeAsyncCollection()

        await _indexes.ensure(collection, ordinary=_indexes.memory_specs(), create=True)

        assert len(collection.created_indexes) == len(MEMORY_ROWS)

    async def test_an_index_matching_on_keys_and_options_is_left_alone(self) -> None:
        collection: Any = FakeAsyncCollection(
            indexes={"whatever_they_called_it": existing(("expires_at", 1), expireAfterSeconds=0)}
        )

        await _indexes.ensure(collection, ordinary=_indexes.storage_specs(), create=True)

        assert collection.created_indexes == []

    async def test_matching_is_on_the_key_list_rather_than_the_name(self) -> None:
        """Forced rather than preferred. Measured: creating a second index over keys that already
        carry one returns code 85 whatever name is used, so a name-keyed check would try, fail, and
        report a conflict the caller cannot act on. The index above is named nothing like ours."""
        collection: Any = FakeAsyncCollection(indexes={"legacy_ttl": existing(("expires_at", 1), expireAfterSeconds=0)})

        await _indexes.ensure(collection, ordinary=_indexes.storage_specs(), create=True)

        assert collection.created_indexes == []

    async def test_a_matching_key_list_with_a_missing_option_raises(self) -> None:
        """AT-063. The case that made this requirement change: an ordinary compound index over the
        dedup keys satisfies a key-list check exactly and stops no duplicates, so accepting it ships
        premortem **P-5** with every index reported present."""
        from strands.types.exceptions import StorageError

        dedup = self._dedup_spec()
        collection: Any = FakeAsyncCollection(indexes={"theirs": existing(*dedup.keys)})

        with pytest.raises(StorageError) as caught:
            await _indexes.ensure(collection, ordinary=[dedup], create=True)

        message = str(caught.value)
        assert "unique" in message

    async def test_the_mismatch_message_carries_found_wanted_and_the_remedy(self) -> None:
        """Naming the option is half of it. The reader has to know what to do, and what to do is drop
        an index somebody else created, which is why we report it instead of doing it."""
        from strands.types.exceptions import StorageError

        dedup = self._dedup_spec()
        collection: Any = FakeAsyncCollection(indexes={"theirs": existing(*dedup.keys)})

        with pytest.raises(StorageError) as caught:
            await _indexes.ensure(collection, ordinary=[dedup], create=True)

        message = str(caught.value)
        assert "theirs" in message
        assert "dropIndex" in message

    async def test_a_mismatch_raises_even_when_creation_is_allowed(self) -> None:
        """``ensure_indexes=True`` cannot fix this one. Creating over those keys is code 85, and
        dropping the existing index is not ours to do."""
        from strands.types.exceptions import StorageError

        dedup = self._dedup_spec()
        collection: Any = FakeAsyncCollection(indexes={"theirs": existing(*dedup.keys)})

        with pytest.raises(StorageError):
            await _indexes.ensure(collection, ordinary=[dedup], create=True)
        assert collection.created_indexes == []

    async def test_a_differing_ttl_is_a_mismatch_rather_than_a_match(self) -> None:
        """AT-064 / REQ-E-064. ``expireAfterSeconds`` stopped being a TTL special case once the
        comparison covered every option we ask for: it is one option among four."""
        from strands.types.exceptions import StorageError

        collection: Any = FakeAsyncCollection(
            indexes={"strands_expires_at_ttl": existing(("expires_at", 1), expireAfterSeconds=3600)}
        )

        with pytest.raises(StorageError, match="expireAfterSeconds"):
            await _indexes.ensure(collection, ordinary=_indexes.storage_specs(), create=True)

    async def test_the_conflict_message_names_the_value_the_index_actually_has(self) -> None:
        """Naming the option is not enough to act on. Whoever reads this has to decide whether the
        existing index is theirs and whether losing its setting matters, and that decision needs both
        numbers. Found by mutation: replacing the rendered value with a fixed string left all 129 tests
        passing, because every assertion here matched on the option's *name*."""
        from strands.types.exceptions import StorageError

        collection: Any = FakeAsyncCollection(
            indexes={"strands_expires_at_ttl": existing(("expires_at", 1), expireAfterSeconds=3600)}
        )

        with pytest.raises(StorageError) as caught:
            await _indexes.ensure(collection, ordinary=_indexes.storage_specs(), create=True)

        assert "its expireAfterSeconds is 3600 and this package needs 0" in str(caught.value)

    async def test_an_index_that_covers_the_keys_but_lacks_the_option_reads_as_absent(self) -> None:
        """A plain index on ``expires_at`` with no TTL at all is the likelier accident than a TTL set to
        the wrong number, and the message has a separate arm for it. Branch coverage cannot see this
        arm: it is the false side of a conditional expression inside one statement, so the module read
        as fully covered while half of this line had never run."""
        from strands.types.exceptions import StorageError

        collection: Any = FakeAsyncCollection(indexes={"someone_elses": existing(("expires_at", 1))})

        with pytest.raises(StorageError) as caught:
            await _indexes.ensure(collection, ordinary=_indexes.storage_specs(), create=True)

        assert "its expireAfterSeconds is absent and this package needs 0" in str(caught.value)

    async def test_server_defaults_we_never_asked_for_are_not_mismatches(self) -> None:
        """The comparison covers options this package sets. ``v``, ``background`` and anything else the
        server or another tool added are not ours to have an opinion about, and treating them as
        mismatches would make every index on a real deployment look wrong."""
        collection: Any = FakeAsyncCollection(
            indexes={"theirs": existing(("expires_at", 1), expireAfterSeconds=0, background=True, hidden=False)}
        )

        await _indexes.ensure(collection, ordinary=_indexes.storage_specs(), create=True)

        assert collection.created_indexes == []

    async def test_a_partial_expression_reported_as_a_son_still_compares_equal(self) -> None:
        """``index_information`` returns ``partialFilterExpression`` as a ``bson.son.SON``. Measured:
        ``SON`` subclasses ``dict`` and compares equal to the plain dict we sent, so the comparison
        needs no normalisation step. Asserted rather than trusted, because if it were false every
        deployment would report the dedup index as mismatched."""
        from bson.son import SON

        dedup = self._dedup_spec()
        collection: Any = FakeAsyncCollection(
            indexes={
                "theirs": existing(
                    *dedup.keys,
                    unique=True,
                    partialFilterExpression=SON([("content_hash", SON([("$exists", True)]))]),
                )
            }
        )

        await _indexes.ensure(collection, ordinary=[dedup], create=True)

        assert collection.created_indexes == []

    async def test_verify_only_creates_nothing_and_raises_on_the_missing_index(self) -> None:
        """AT-061 / REQ-E-061."""
        from strands.types.exceptions import StorageError

        collection: Any = FakeAsyncCollection()

        with pytest.raises(StorageError) as caught:
            await _indexes.ensure(collection, ordinary=_indexes.storage_specs(), create=False)

        assert collection.created_indexes == []
        assert "createIndex" in str(caught.value)

    async def test_the_verify_only_error_names_every_missing_index_not_only_the_first(self) -> None:
        """A caller who has to raise a ticket per index raises three tickets. The commands are all
        computable in one pass, so the message carries all of them."""
        from strands.types.exceptions import StorageError

        collection: Any = FakeAsyncCollection()

        with pytest.raises(StorageError) as caught:
            await _indexes.ensure(collection, ordinary=_indexes.memory_specs(), create=False)

        assert str(caught.value).count("createIndex") == len(MEMORY_ROWS)

    async def test_verify_only_passes_when_everything_is_present(self) -> None:
        collection: Any = FakeAsyncCollection()
        await _indexes.ensure(collection, ordinary=_indexes.memory_specs(), create=True)

        await _indexes.ensure(collection, ordinary=_indexes.memory_specs(), create=False)

        assert len(collection.created_indexes) == len(MEMORY_ROWS)

    async def test_an_unexpected_driver_error_surfaces_as_a_storage_error(self) -> None:
        """Code 13 is unauthorized: a real answer to "may I create indexes", and not one this module
        can act on. It arrives wrapped, because ``StorageError`` is what a caller catches, with the
        original chained so the code and message survive."""
        from strands.types.exceptions import StorageError

        collection: Any = FakeAsyncCollection()
        collection.create_indexes = raiser(operation_failure(13, "not authorized"))  # type: ignore[method-assign]

        with pytest.raises(StorageError) as caught:
            await _indexes.ensure(collection, ordinary=_indexes.storage_specs(), create=True)

        assert caught.value.__cause__ is not None
        assert "not authorized" in str(caught.value.__cause__)

    async def test_nothing_is_read_when_there_is_nothing_to_ensure(self) -> None:
        """``storage`` has no search indexes, so its ``initialize()`` passes an empty list. That must
        not cost a round trip."""
        collection: Any = FakeAsyncCollection()
        collection.index_information = raiser(AssertionError("should not be called"))  # type: ignore[method-assign]

        await _indexes.ensure(collection, create=True)

    @staticmethod
    def _dedup_spec() -> _indexes.IndexSpec:
        """The unique partial index from §6.8 row 3."""
        return next(spec for spec in _indexes.memory_specs() if spec.options.get("unique"))


def search_states(name: str, *statuses: str, definition: Mapping[str, Any] | None = None) -> Any:
    """Program a search index's successive ``list_search_indexes`` reads from a status sequence.

    Args:
        name: Index name the poll loop will ask for.
        statuses: One status per read, in order. ``""`` means the index is absent on that read.
        definition: What ``latestDefinition`` reports, when the caller cares.

    Returns:
        A ``search_states`` mapping for :class:`FakeAsyncCollection`.
    """
    reads: list[list[dict[str, Any]]] = []
    for status in statuses:
        if not status:
            reads.append([])
            continue
        document: dict[str, Any] = {"name": name, "status": status, "queryable": status == "READY"}
        if definition is not None:
            document["latestDefinition"] = definition
        reads.append([document])
    return {name: reads}


class TestSearchIndexesAgainstAFake:
    """REQ-E-062, REQ-E-066, REQ-E-068 — the three states, the status vocabulary, and the swallow.

    An asynchronous build is the one thing a fake models well: the states are just successive reads.
    What a fake cannot show is that the states occur, which is what ``AT-062a/b/c`` go to Atlas for.
    """

    async def test_a_missing_index_is_created_and_then_polled_to_ready(self) -> None:
        collection: Any = FakeAsyncCollection(search_states=search_states("vector_index", "", "BUILDING", "READY"))

        await _indexes.ensure(
            collection,
            search=[_indexes.memory_search_specs({"database": "d"})[0]],
            create=True,
            interval=0,
        )

        assert len(collection.created_search_indexes) == 1

    async def test_the_collection_is_created_before_the_search_index(self) -> None:
        """AT-068 / REQ-E-068. ``createSearchIndexes`` against a missing namespace is code 26, while
        ``createIndexes`` creates the collection implicitly. The reference implementation's
        otherwise odd list-then-create is required rather than defensive."""
        collection: Any = FakeAsyncCollection(name="memory", search_states=search_states("vector_index", "", "READY"))

        await _indexes.ensure(
            collection,
            search=[_indexes.memory_search_specs({"database": "d"})[0]],
            create=True,
            interval=0,
        )

        assert collection.database.create_collection_calls[0][0] == "memory"

    async def test_the_collection_is_created_without_a_client_side_existence_check(self) -> None:
        """``check_exists=False`` removes a check-then-act race and a round trip. It also removes
        ``CollectionInvalid`` from the picture entirely: pymongo raises that only from the
        client-side branch, so a server-side race arrives as code 48 instead."""
        collection: Any = FakeAsyncCollection(search_states=search_states("vector_index", "", "READY"))

        await _indexes.ensure(
            collection,
            search=[_indexes.memory_search_specs({"database": "d"})[0]],
            create=True,
            interval=0,
        )

        assert collection.database.create_collection_calls[0][1] == {"check_exists": False}

    async def test_a_collection_that_already_exists_is_not_an_error(self) -> None:
        """Code 48 is ``NamespaceExists``, which is the outcome the check we skipped was predicting.
        On 8.3.8 with ``check_exists=False`` the second create is silently accepted and 48 never
        arrives, so this branch is defense in depth for other server versions. Driven from a fake
        rather than left as an unexercised line."""
        collection: Any = FakeAsyncCollection(
            database=FakeAsyncDatabase(create_error=operation_failure(48, "NamespaceExists")),
            search_states=search_states("vector_index", "", "READY"),
        )

        await _indexes.ensure(
            collection,
            search=[_indexes.memory_search_specs({"database": "d"})[0]],
            create=True,
            interval=0,
        )

        assert len(collection.created_search_indexes) == 1

    async def test_a_collection_creation_failure_that_is_not_code_48_surfaces(self) -> None:
        """Only 48 is swallowed. Code 13 means the caller may not create collections, which is
        information rather than noise."""
        from strands.types.exceptions import StorageError

        collection: Any = FakeAsyncCollection(
            database=FakeAsyncDatabase(create_error=operation_failure(13, "not authorized")),
            search_states=search_states("vector_index", "", "READY"),
        )

        with pytest.raises(StorageError):
            await _indexes.ensure(
                collection,
                search=[_indexes.memory_search_specs({"database": "d"})[0]],
                create=True,
                interval=0,
            )

    async def test_an_index_already_ready_is_left_alone_and_the_collection_is_not_touched(self) -> None:
        """A second ``initialize()`` on a warm deployment should cost two reads and no writes."""
        collection: Any = FakeAsyncCollection(search_states=search_states("vector_index", "READY"))

        await _indexes.ensure(
            collection,
            search=[_indexes.memory_search_specs({"database": "d"})[0]],
            create=True,
            interval=0,
        )

        assert collection.created_search_indexes == []
        assert collection.database.create_collection_calls == []

    @pytest.mark.parametrize("status", ["PENDING", "BUILDING", "STAGED", "SOMETHING_NEW"])
    async def test_every_status_that_is_not_ready_or_failed_is_read_as_building(self, status: str) -> None:
        """The mapping is written the other way round from the design's first draft, and that is the
        finding: ``PENDING`` was observed on 8.3.8 and was not in the list. ``READY`` is ready,
        ``FAILED`` is missing-with-detail, everything else waits. An unrecognised status read as
        building costs one poll; read as ready it ships premortem **P-2**, where search returns zero
        documents and the user reads it as the agent forgetting. Full vocabulary is ``O-12``."""
        collection: Any = FakeAsyncCollection(search_states=search_states("vector_index", status, "READY"))

        await _indexes.ensure(
            collection,
            search=[_indexes.memory_search_specs({"database": "d"})[0]],
            create=True,
            interval=0,
        )

        assert collection.created_search_indexes == []

    async def test_a_failed_build_raises_with_the_failure_detail(self) -> None:
        """AT-062a's sibling, and the one branch Atlas local would not produce. Reported rather than
        recreated: an identical definition is accepted while a build is failed and does not restart it,
        so a create here would wait out the whole timeout to learn what the status already said. The
        remedy needs a drop, and dropping an index is not ours to do."""
        from strands.types.exceptions import StorageError

        states: dict[str, Sequence[list[dict[str, Any]]]] = {
            "vector_index": [
                [
                    {
                        "name": "vector_index",
                        "status": "FAILED",
                        "queryable": False,
                        "latestDefinition": {},
                        "statusDetail": [{"hostname": "mongot-0", "mainIndex": {"message": "oom"}}],
                    }
                ]
            ]
        }
        collection: Any = FakeAsyncCollection(search_states=states)

        with pytest.raises(StorageError) as caught:
            await _indexes.ensure(
                collection,
                search=[_indexes.memory_search_specs({"database": "d"})[0]],
                create=True,
                interval=0,
            )

        message = str(caught.value)
        assert "FAILED" in message
        assert "oom" in message
        assert "dropSearchIndex" in message

    async def test_a_build_that_fails_partway_through_raises_rather_than_waiting_it_out(self) -> None:
        """The same state reached from the other direction, and the one a fake is needed for.

        The test above finds ``FAILED`` on the first read, which is what a second ``initialize()`` sees.
        This is what the *first* one sees: the build starts, reports ``BUILDING``, and then fails. Both
        paths have to raise, because waiting for a failed build to become ready is a 120 second wait for
        a status that will not change.

        Which is why the call is ``bounded``: this test's name is a claim about *not* waiting, and
        without a bound the version that waits still fails, two minutes later, on the default timeout.
        """
        from strands.types.exceptions import StorageError

        failed = {
            "name": "vector_index",
            "status": "FAILED",
            "queryable": False,
            "statusDetail": [{"hostname": "mongot-0", "mainIndex": {"message": "disk full"}}],
        }
        collection: Any = FakeAsyncCollection(
            search_states={"vector_index": [[{"name": "vector_index", "status": "BUILDING"}], [failed]]}
        )

        with pytest.raises(StorageError) as caught:
            await bounded(
                _indexes.ensure(
                    collection,
                    search=[_indexes.memory_search_specs({"database": "d"})[0]],
                    create=False,
                    interval=0,
                )
            )

        assert "disk full" in str(caught.value)

    async def test_an_index_dropped_mid_build_is_waited_for_rather_than_recreated(self) -> None:
        """A gap in the states nothing else covers: the index was there on the first read and is gone on
        the second, because something else dropped it.

        Waiting is the only move left. Reporting ready would be false, and creating it would race
        whoever is holding the other end of the drop. So the wait runs out and the timeout message says
        the index is absent, which is the one thing the reader could not have guessed.
        """
        from strands.types.exceptions import StorageError

        collection: Any = FakeAsyncCollection(search_states=search_states("vector_index", "BUILDING", ""))

        with pytest.raises(StorageError, match="absent"):
            await bounded(
                _indexes.ensure(
                    collection,
                    search=[_indexes.memory_search_specs({"database": "d"})[0]],
                    create=False,
                    timeout=0,
                    interval=0,
                )
            )

    async def test_a_present_index_with_a_different_definition_raises(self) -> None:
        """Measured: re-issuing a *different* definition under an existing name is code 68, *"already
        exists with a different definition. Drop it first if needed."* That, and not the fact that
        re-creation fails, is what makes the reference's list-then-bail pattern worth keeping."""
        from strands.types.exceptions import StorageError

        spec = _indexes.memory_search_specs({"database": "d"})[0]
        collection: Any = FakeAsyncCollection(
            search_states=search_states(
                spec.name, "READY", definition={"fields": [{"type": "vector", "path": "other"}]}
            )
        )

        with pytest.raises(StorageError) as caught:
            await _indexes.ensure(collection, search=[spec], create=True, interval=0)

        assert "dropSearchIndex" in str(caught.value)
        assert collection.created_search_indexes == []

    async def test_an_identical_definition_is_a_match_even_reported_back_by_the_server(self) -> None:
        """``latestDefinition`` round-trips byte for byte for a ``vectorSearch`` index, measured on
        8.3.8. Asserted rather than assumed, because it is half of what makes definitions comparable
        and it is the half that does **not** generalise: see the text-index tests below."""
        spec = _indexes.memory_search_specs({"database": "d"})[0]
        collection: Any = FakeAsyncCollection(
            search_states=search_states(spec.name, "READY", definition=spec.definition)
        )

        await _indexes.ensure(collection, search=[spec], create=True, interval=0)

        assert collection.created_search_indexes == []

    async def test_the_definition_mongot_rewrites_for_a_text_index_is_still_a_match(self) -> None:
        """AT-069 / REQ-E-069, and the finding the whole requirement exists for.

        The reported shape below is copied from mongot 8.3.8 rather than constructed: it collapses the
        one-element list we sent into the object it held and fills in three defaults nobody asked for.
        Comparing for equality passes on the vector index above and fails here, so every second
        ``initialize()`` would refuse to run over a text index the first one created.
        """
        spec = _indexes.memory_search_specs({"database": "d"})[1]
        rewritten = {
            "mappings": {
                "dynamic": False,
                "fields": {
                    "content": {
                        "type": "string",
                        "indexOptions": "offsets",
                        "store": True,
                        "norms": "include",
                    }
                },
            }
        }
        collection: Any = FakeAsyncCollection(search_states=search_states(spec.name, "READY", definition=rewritten))

        await _indexes.ensure(collection, search=[spec], create=True, interval=0)

        assert collection.created_search_indexes == []

    async def test_a_text_index_mapped_over_a_different_field_is_a_mismatch(self) -> None:
        """The reason tolerating the rewrite cannot become tolerating anything. A ``text_index`` that
        langchain built over its own field name is present, healthy, and answers every search this
        package issues with nothing."""
        from strands.types.exceptions import StorageError

        spec = _indexes.memory_search_specs({"database": "d"})[1]
        theirs = {"mappings": {"dynamic": False, "fields": {"text": {"type": "string"}}}}
        collection: Any = FakeAsyncCollection(search_states=search_states(spec.name, "READY", definition=theirs))

        with pytest.raises(StorageError, match="dropSearchIndex"):
            await _indexes.ensure(collection, search=[spec], create=True, interval=0)

    async def test_a_vector_index_with_the_wrong_dimension_count_is_a_mismatch(self) -> None:
        """The same failure on the vector side, and the likelier one: 1536 is what an OpenAI-shaped
        ``vector_index`` carries, and a query vector of a different length is rejected per query rather
        than at initialize."""
        from strands.types.exceptions import StorageError

        spec = _indexes.memory_search_specs({"database": "d", "embedding_dimensions": 1024, "similarity": "cosine"})[0]
        theirs = {
            "fields": [
                {"type": "vector", "path": "embedding", "numDimensions": 1536, "similarity": "cosine"},
                {"type": "filter", "path": "scope"},
                {"type": "filter", "path": "store_name"},
            ]
        }
        collection: Any = FakeAsyncCollection(search_states=search_states(spec.name, "READY", definition=theirs))

        with pytest.raises(StorageError, match="numDimensions"):
            await _indexes.ensure(collection, search=[spec], create=True, interval=0)

    async def test_a_missing_filter_path_is_a_mismatch(self) -> None:
        """``REQ-E-071`` through the verify path. An index that never declared ``store_name`` filterable
        returns *unfiltered* results for a query that filters on it (§6.3), which on the memory
        collection is another customer's memories. Present-but-underdeclared is the dangerous state."""
        from strands.types.exceptions import StorageError

        spec = _indexes.memory_search_specs({"database": "d"})[0]
        theirs = {
            "fields": [
                dict(spec.definition["fields"][0]),
                {"type": "filter", "path": "scope"},
            ]
        }
        collection: Any = FakeAsyncCollection(search_states=search_states(spec.name, "READY", definition=theirs))

        with pytest.raises(StorageError, match="store_name"):
            await _indexes.ensure(collection, search=[spec], create=True, interval=0)

    async def test_fields_the_server_or_another_tool_added_are_not_mismatches(self) -> None:
        """Same rule as the ordinary indexes, reached from the same direction: the comparison covers
        what this package declared. An extra filter path somebody else needs costs nothing here, and
        failing over it would make this package refuse to share a collection."""
        spec = _indexes.memory_search_specs({"database": "d"})[0]
        theirs = {
            "fields": [
                *(dict(f) for f in spec.definition["fields"]),
                {"type": "filter", "path": "their_own_field"},
            ]
        }
        collection: Any = FakeAsyncCollection(search_states=search_states(spec.name, "READY", definition=theirs))

        await _indexes.ensure(collection, search=[spec], create=True, interval=0)

        assert collection.created_search_indexes == []

    async def test_dynamic_mapping_turned_on_is_a_mismatch(self) -> None:
        """``dynamic: True`` is a scalar difference rather than a missing key, so it exercises the other
        half of the comparison. It also matters on its own: dynamic mapping indexes every field of every
        document, including whatever a caller attached to a memory."""
        from strands.types.exceptions import StorageError

        spec = _indexes.memory_search_specs({"database": "d"})[1]
        theirs = {"mappings": {"dynamic": True, "fields": {"content": {"type": "string"}}}}
        collection: Any = FakeAsyncCollection(search_states=search_states(spec.name, "READY", definition=theirs))

        with pytest.raises(StorageError, match="dynamic"):
            await _indexes.ensure(collection, search=[spec], create=True, interval=0)

    async def test_verify_only_raises_with_the_search_creation_command(self) -> None:
        from strands.types.exceptions import StorageError

        collection: Any = FakeAsyncCollection(search_states=search_states("vector_index", ""))

        with pytest.raises(StorageError) as caught:
            await _indexes.ensure(
                collection,
                search=[_indexes.memory_search_specs({"database": "d"})[0]],
                create=False,
                interval=0,
            )

        assert "createSearchIndex" in str(caught.value)
        assert collection.created_search_indexes == []

    async def test_verify_only_still_waits_for_a_build_somebody_else_started(self) -> None:
        """Building is not missing, and the remedy for building is to wait. Returning early would hand
        the caller a store whose searches return nothing, which is the failure verification exists to
        prevent."""
        collection: Any = FakeAsyncCollection(
            search_states=search_states("vector_index", "BUILDING", "BUILDING", "READY")
        )

        await _indexes.ensure(
            collection,
            search=[_indexes.memory_search_specs({"database": "d"})[0]],
            create=False,
            interval=0,
        )

        assert collection.created_search_indexes == []

    async def test_a_build_that_never_finishes_times_out_naming_the_last_status(self) -> None:
        """120 seconds of silence followed by a bare timeout tells the reader nothing. The status is
        the actionable part: ``BUILDING`` at timeout is a slow build, and anything else is ``O-12``.

        The call goes through ``bounded`` for the reason recorded there: this is one of the two tests
        whose termination would otherwise depend on the deadline check it is testing.
        """
        from strands.types.exceptions import StorageError

        collection: Any = FakeAsyncCollection(search_states=search_states("vector_index", "BUILDING"))

        with pytest.raises(StorageError) as caught:
            await bounded(
                _indexes.ensure(
                    collection,
                    search=[_indexes.memory_search_specs({"database": "d"})[0]],
                    create=True,
                    timeout=0,
                    interval=0,
                )
            )

        message = str(caught.value)
        assert "BUILDING" in message
        assert "vector_index" in message

    async def test_the_default_timeout_and_interval_match_the_reference_helpers(self) -> None:
        """``pymongo_search_utils`` polls with ``TIMEOUT = 120`` and ``INTERVAL = 0.5``. Reimplementing
        those helpers against ``AsyncCollection`` (``REQ-E-066``) is not a reason to also change how
        long a caller waits."""
        assert _indexes.READY_TIMEOUT_SECONDS == 120
        assert _indexes.POLL_INTERVAL_SECONDS == 0.5

    async def test_polling_yields_to_the_event_loop_between_reads(self) -> None:
        """``REQ-E-066``'s actual point. The reference helpers use a blocking ``time.sleep``, which in
        an async agent stalls every other coroutine on the loop for up to two minutes."""
        collection: Any = FakeAsyncCollection(
            search_states=search_states("vector_index", "BUILDING", "BUILDING", "READY")
        )
        ticks = 0

        async def tick() -> None:
            nonlocal ticks
            while True:
                ticks += 1
                await asyncio.sleep(0)

        ticker = asyncio.create_task(tick())
        try:
            await _indexes.ensure(
                collection,
                search=[_indexes.memory_search_specs({"database": "d"})[0]],
                create=False,
                interval=0,
            )
        finally:
            ticker.cancel()

        assert ticks > 0

    async def test_a_read_against_a_collection_that_does_not_exist_reads_as_absent(self) -> None:
        """The other half of ``REQ-E-068``'s asymmetry, on the read rather than the write.

        pymongo normalises code 26 for ordinary indexes itself: ``list_indexes`` passes
        ``allowable_errors=[26]``, so ``index_information()`` on a missing collection answers ``{}``.
        ``list_search_indexes`` carries no such allowance, and it is an aggregate rather than a command,
        so the same normalisation is done here. Raising instead would mean a first ``initialize()``
        against a fresh database fails before it has created anything.
        """
        spec = _indexes.memory_search_specs({"database": "d"})[0]
        collection: Any = FakeAsyncCollection(search_states=search_states(spec.name, "READY"))
        real = collection.list_search_indexes
        reads = 0

        async def missing_namespace_on_the_first_read(name: str | None = None) -> Any:
            nonlocal reads
            reads += 1
            if reads == 1:
                raise operation_failure(26, "ns does not exist: testdb.memory")
            return await real(name)

        collection.list_search_indexes = missing_namespace_on_the_first_read

        await _indexes.ensure(collection, search=[spec], create=True, interval=0)

        assert len(collection.created_search_indexes) == 1

    async def test_a_read_that_fails_for_any_other_reason_surfaces(self) -> None:
        """Only 26 is swallowed. Code 13 means the caller may not list search indexes, and treating
        that as "no indexes exist" would drive a create that fails the same way one call later.

        ``bounded`` because the wrong behaviour here is a *slow* pass into the poll loop rather than a
        fast wrong answer: swallowing code 13 sends this call to the default 120 second timeout.
        """
        from strands.types.exceptions import StorageError

        collection: Any = FakeAsyncCollection()
        collection.list_search_indexes = raiser(operation_failure(13, "not authorized"))

        with pytest.raises(StorageError, match="vector_index"):
            await bounded(
                _indexes.ensure(
                    collection,
                    search=[_indexes.memory_search_specs({"database": "d"})[0]],
                    create=True,
                    interval=0,
                )
            )

        assert collection.created_search_indexes == []

    async def test_a_read_that_never_reached_the_server_surfaces(self) -> None:
        """A ``PyMongoError`` that is not an ``OperationFailure`` has no ``code`` to compare, which is
        why there are two handlers rather than one ``if error.code != 26``. Comparing a code on this
        exception raises ``AttributeError`` from inside the error handler, losing the real cause."""
        from strands.types.exceptions import StorageError

        collection: Any = FakeAsyncCollection()
        collection.list_search_indexes = raiser(network_failure())

        with pytest.raises(StorageError) as caught:
            await _indexes.ensure(
                collection,
                search=[_indexes.memory_search_specs({"database": "d"})[0]],
                create=True,
                interval=0,
            )

        assert "socket timed out" in str(caught.value.__cause__)

    async def test_a_collection_creation_that_never_reached_the_server_surfaces(self) -> None:
        """Same two-handler reasoning as the read above, on ``create_collection``. Code 48 is the only
        swallowed outcome, and a dropped connection carries no code to compare it against."""
        from strands.types.exceptions import StorageError

        collection: Any = FakeAsyncCollection(
            database=FakeAsyncDatabase(create_error=network_failure()),
            search_states=search_states("vector_index", "", "READY"),
        )

        with pytest.raises(StorageError) as caught:
            await _indexes.ensure(
                collection,
                search=[_indexes.memory_search_specs({"database": "d"})[0]],
                create=True,
                interval=0,
            )

        assert "creating the collection" in str(caught.value)
        assert collection.created_search_indexes == []

    async def test_an_object_reported_where_one_was_declared_is_a_mismatch(self) -> None:
        """``REQ-E-069``'s comparison walks nested objects, so it has to answer for a reported value of
        the wrong *kind* as well as the wrong value. Reachable in practice: mongot rewrites ``search``
        definitions (§4.2), so a future rewrite could flatten ``mappings`` into something that is not
        an object, and the comparison must say so rather than raise ``AttributeError``."""
        from strands.types.exceptions import StorageError

        spec = _indexes.memory_search_specs({"database": "d"})[1]
        collection: Any = FakeAsyncCollection(
            search_states=search_states(spec.name, "READY", definition={"mappings": "dynamic"})
        )

        with pytest.raises(StorageError, match="declared the object"):
            await _indexes.ensure(collection, search=[spec], create=True, interval=0)

    async def test_a_list_reported_as_a_scalar_is_a_mismatch(self) -> None:
        """The list arm of the same question. A single declared entry is allowed to arrive as a bare
        object, because that is exactly what mongot does to ``fields`` inside a ``search`` mapping, but
        a string is neither and reports as a mismatch rather than being coerced."""
        from strands.types.exceptions import StorageError

        spec = _indexes.memory_search_specs({"database": "d"})[0]
        collection: Any = FakeAsyncCollection(
            search_states=search_states(spec.name, "READY", definition={"fields": "everything"})
        )

        with pytest.raises(StorageError, match="declared the list"):
            await _indexes.ensure(collection, search=[spec], create=True, interval=0)

    async def test_a_status_is_logged_when_it_changes_and_not_on_every_poll(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """A build that takes the full 120 seconds is 240 polls. Logging each one buries the operator's
        own output; logging none makes a slow build indistinguishable from a hang. The line is therefore
        per transition, which is also the only signal that says which of the two is happening."""
        spec = _indexes.memory_search_specs({"database": "d"})[0]
        collection: Any = FakeAsyncCollection(
            search_states=search_states(spec.name, "BUILDING", "BUILDING", "BUILDING", "READY")
        )

        with caplog.at_level(logging.INFO, logger="strands_mongodb"):
            await _indexes.ensure(collection, search=[spec], create=False, interval=0)

        statuses = [record.getMessage() for record in caplog.records if spec.name in record.getMessage()]
        assert sum("BUILDING" in message for message in statuses) == 1, statuses
        assert sum("READY" in message for message in statuses) == 1, statuses


class TestTheFakesMatchTheDriver:
    """MP-001, MP-002 — the parity contract for both fakes in this file.

    This is the structural fix for the unawaited-coroutine class of bug: a fake that returns a value
    where the driver returns a coroutine passes every test above and fails on first real traffic. The
    check is mechanical on purpose, so it keeps holding as the module grows.
    """

    # Every driver method this module calls, and the arguments it calls them with.
    CALLS: tuple[tuple[str, str, tuple[Any, ...], dict[str, Any]], ...] = (
        ("AsyncCollection", "index_information", (), {}),
        ("AsyncCollection", "create_indexes", ([],), {}),
        ("AsyncCollection", "list_search_indexes", (), {}),
        ("AsyncCollection", "create_search_index", (None,), {}),
        ("AsyncDatabase", "create_collection", ("name",), {"check_exists": False}),
    )

    @pytest.mark.parametrize(("owner", "method", "args", "kwargs"), CALLS)
    def test_every_method_the_module_calls_is_a_coroutine_function_on_the_real_class(
        self, owner: str, method: str, args: tuple[Any, ...], kwargs: dict[str, Any]
    ) -> None:
        """MP-001. ``async def`` on the fake is worth nothing unless it is ``async def`` upstream."""
        real = getattr(self._driver_class(owner), method)

        assert inspect.iscoroutinefunction(real), f"{owner}.{method} is not a coroutine function"

    @pytest.mark.parametrize(("owner", "method", "args", "kwargs"), CALLS)
    def test_the_real_signature_accepts_the_arguments_we_pass(
        self, owner: str, method: str, args: tuple[Any, ...], kwargs: dict[str, Any]
    ) -> None:
        """A fake with ``**kwargs`` accepts anything. The driver does not, and ``check_exists`` in
        particular is the argument this module's collection creation depends on."""
        signature = inspect.signature(getattr(self._driver_class(owner), method))

        signature.bind(None, *args, **kwargs)

    @pytest.mark.parametrize(("owner", "method", "args", "kwargs"), CALLS)
    def test_the_fake_offers_the_same_method_as_a_coroutine_function(
        self, owner: str, method: str, args: tuple[Any, ...], kwargs: dict[str, Any]
    ) -> None:
        fake = FakeAsyncCollection if owner == "AsyncCollection" else FakeAsyncDatabase

        assert inspect.iscoroutinefunction(getattr(fake, method))

    def test_the_fake_collection_raises_for_an_unknown_attribute(self) -> None:
        """The real ``AsyncCollection.__getattr__`` resolves any unknown name to a sub-collection, so
        ``getattr(collection, "typo")`` is truthy and never raises. That trap has already cost this
        project twice. The fake is stricter than the driver here, deliberately: a typo in the module
        under test fails in the unit tier rather than at 3am."""
        with pytest.raises(AttributeError):
            FakeAsyncCollection().definitely_not_a_method  # type: ignore[attr-defined]  # noqa: B018

    def test_the_fake_cursor_is_async_iterable(self) -> None:
        """MP-002."""
        cursor = FakeSearchIndexCursor([{"name": "n", "status": "READY"}])

        assert hasattr(cursor, "__aiter__")

    def test_the_fake_cursor_is_not_synchronously_iterable(self) -> None:
        """MP-002, and the half that matters. ``AsyncCommandCursor`` has no ``__iter__``, measured on
        pymongo 4.17.0, so a fake that grew one would let ``for index in cursor`` pass here."""
        assert not hasattr(FakeSearchIndexCursor([]), "__iter__")

    def test_the_real_cursor_is_not_synchronously_iterable_either(self) -> None:
        """The claim above, checked against the class rather than against memory of it."""
        from pymongo.asynchronous.command_cursor import AsyncCommandCursor

        assert hasattr(AsyncCommandCursor, "__aiter__")
        assert not hasattr(AsyncCommandCursor, "__iter__")

    def test_list_search_indexes_is_awaitable_and_returns_the_cursor(self) -> None:
        """Two shapes are plausible and only one is real: ``list_search_indexes`` is itself a
        coroutine, so the cursor arrives from ``await``, not from iterating the call directly. Getting
        this backwards is a ``TypeError`` on a real deployment and nothing at all against a loose
        fake."""
        from pymongo.asynchronous.collection import AsyncCollection

        assert inspect.iscoroutinefunction(AsyncCollection.list_search_indexes)

    @staticmethod
    def _driver_class(owner: str) -> type:
        from pymongo.asynchronous.collection import AsyncCollection
        from pymongo.asynchronous.database import AsyncDatabase

        return AsyncCollection if owner == "AsyncCollection" else AsyncDatabase


@pytest.mark.contract
class TestOrdinaryIndexesAgainstARealDeployment:
    """AT-060, AT-061, AT-063, AT-064 — the same branches, against a server that answers for itself.

    The fake above encodes what design delta §4.2 measured. These tests are what stop that encoding
    from drifting away from the server: they assert outcomes rather than error codes, so a server
    upgrade that renumbers a conflict fails here rather than in production.
    """

    async def test_ensure_creates_every_declared_index(
        self, contract_database: Any, unique_collection_name: str
    ) -> None:
        """AT-060 / REQ-E-060. Also shows ``createIndexes`` creating the collection implicitly: nothing
        creates ``unique_collection_name`` first, and the search path is the only one that has to."""
        collection = contract_database[unique_collection_name]

        await _indexes.ensure(collection, ordinary=_indexes.memory_specs(), create=True)

        keys = {tuple(spec["key"]) for spec in (await collection.index_information()).values()}
        for spec in _indexes.memory_specs():
            assert spec.keys in keys

    async def test_a_second_ensure_creates_nothing_and_raises_nothing(
        self, contract_database: Any, unique_collection_name: str
    ) -> None:
        """The idempotency the whole module exists for, end to end rather than by branch."""
        collection = contract_database[unique_collection_name]
        await _indexes.ensure(collection, ordinary=_indexes.memory_specs(), create=True)
        before = await collection.index_information()

        await _indexes.ensure(collection, ordinary=_indexes.memory_specs(), create=True)

        assert await collection.index_information() == before

    async def test_an_index_under_a_foreign_name_with_our_options_is_accepted(
        self, contract_database: Any, unique_collection_name: str
    ) -> None:
        """AT-063 / REQ-E-063, the positive half. Someone else's naming convention is not a reason to
        fail, and it is not a reason to try creating a second index over the same keys either."""
        from pymongo import IndexModel

        collection = contract_database[unique_collection_name]
        spec = _indexes.storage_specs()[0]
        await collection.create_indexes([IndexModel(list(spec.keys), name="their_own_ttl", expireAfterSeconds=0)])

        await _indexes.ensure(collection, ordinary=[spec], create=True)

        assert "their_own_ttl" in await collection.index_information()
        assert spec.name not in await collection.index_information()

    async def test_the_server_rejects_a_second_index_over_the_same_keys(
        self, contract_database: Any, unique_collection_name: str
    ) -> None:
        """The measurement that forces key-list matching, asserted rather than quoted. Without this,
        the test above looks like a stylistic preference instead of the only thing that works."""
        from pymongo import IndexModel
        from pymongo.errors import OperationFailure

        collection = contract_database[unique_collection_name]
        spec = _indexes.storage_specs()[0]
        await collection.create_indexes([IndexModel(list(spec.keys), name="their_own_ttl", expireAfterSeconds=0)])

        with pytest.raises(OperationFailure):
            await collection.create_indexes([spec.to_model()])

    async def test_an_index_missing_the_option_it_exists_for_is_reported(
        self, contract_database: Any, unique_collection_name: str
    ) -> None:
        """AT-063 / REQ-E-063, the half that changed the requirement. A plain compound index over the
        dedup keys is what a well-meaning application developer adds for query performance, and it
        satisfies a key-list check exactly while stopping no duplicates."""
        from pymongo import IndexModel
        from strands.types.exceptions import StorageError

        collection = contract_database[unique_collection_name]
        dedup = next(spec for spec in _indexes.memory_specs() if spec.options.get("unique"))
        await collection.create_indexes([IndexModel(list(dedup.keys), name="just_for_speed")])

        with pytest.raises(StorageError) as caught:
            await _indexes.ensure(collection, ordinary=[dedup], create=True)

        assert "unique" in str(caught.value)
        assert "just_for_speed" in str(caught.value)

    async def test_a_ttl_index_with_a_different_expiry_is_reported(
        self, contract_database: Any, unique_collection_name: str
    ) -> None:
        """AT-064 / REQ-E-064. The server rejects the re-creation too, with code 85 under either name.
        This asserts the package names the reason before the server gets a chance to."""
        from pymongo import IndexModel
        from strands.types.exceptions import StorageError

        collection = contract_database[unique_collection_name]
        spec = _indexes.storage_specs()[0]
        await collection.create_indexes([IndexModel(list(spec.keys), name="theirs", expireAfterSeconds=3600)])

        with pytest.raises(StorageError, match="expireAfterSeconds"):
            await _indexes.ensure(collection, ordinary=[spec], create=True)

    async def test_verify_only_creates_nothing_on_a_real_deployment(
        self, contract_database: Any, unique_collection_name: str
    ) -> None:
        """AT-061 / REQ-E-061. The collection is not created either, which matters: a verify-only run
        is what a caller without DDL rights does, and it must not need any."""
        from strands.types.exceptions import StorageError

        collection = contract_database[unique_collection_name]

        with pytest.raises(StorageError) as caught:
            await _indexes.ensure(collection, ordinary=_indexes.memory_specs(), create=False)

        assert await collection.index_information() == {}
        assert unique_collection_name not in await contract_database.list_collection_names()
        assert unique_collection_name in str(caught.value)

    async def test_the_commands_in_the_verify_only_error_actually_create_the_indexes(
        self, contract_database: Any, unique_collection_name: str
    ) -> None:
        """The point of ``REQ-E-061`` is that somebody runs what the message says.

        So the test runs it. Every ``db.runCommand({...})`` is parsed straight out of the error text and
        executed against the deployment, and then the same verify that produced the message has to pass.
        A command that is merely well formed and does not produce the index the next verify wants is
        worse than no command at all: the operator runs it, the caller still fails, and neither of them
        can tell which half was wrong.
        """
        import json
        import re

        from strands.types.exceptions import StorageError

        collection = contract_database[unique_collection_name]
        specs = _indexes.memory_specs()
        with pytest.raises(StorageError) as caught:
            await _indexes.ensure(collection, ordinary=specs, create=False)

        commands = re.findall(r"db\.runCommand\((\{.*?\})\)\n", str(caught.value))
        assert len(commands) == len(specs), str(caught.value)
        for command in commands:
            await contract_database.command(json.loads(command))

        await _indexes.ensure(collection, ordinary=specs, create=False)

    async def test_ten_concurrent_ensures_produce_one_index_set(
        self, contract_database: Any, unique_collection_name: str
    ) -> None:
        """AT-060's "tolerate a concurrent creator", and the index half of AT-065.

        No lock here, which is stronger than the locked version: this is the check-then-create window
        left wide open, and it is benign. Measured directly first (10 concurrent identical
        ``create_indexes`` calls: zero failures, one index), so the requirement is satisfied by the
        server's own idempotency rather than by an ``except`` clause. Recorded because the alternative
        reading is dangerous: swallowing the conflict codes to tolerate a racer would also swallow the
        genuine option mismatch two tests up.

        ``initialize()`` does not exist until Task 8, so the client half of AT-065 lands there, the way
        AT-014 was completed across two tasks.
        """
        collection = contract_database[unique_collection_name]
        specs = _indexes.memory_specs()

        results = await asyncio.gather(
            *(_indexes.ensure(collection, ordinary=specs, create=True) for _ in range(10)),
            return_exceptions=True,
        )

        assert [r for r in results if isinstance(r, BaseException)] == []
        # `_id_` plus one per spec, and no duplicates under alternate names.
        assert len(await collection.index_information()) == len(specs) + 1

    async def test_the_fake_and_the_driver_report_index_information_the_same_way(
        self, contract_database: Any, unique_collection_name: str
    ) -> None:
        """MP-001's behavioural half. The unit tier's ``existing()`` helper hard-codes a shape; this is
        the test that fails if the driver ever reports ``key`` as something other than a list of
        tuples, or drops the ``v`` the comparison has to ignore."""
        collection = contract_database[unique_collection_name]
        spec = _indexes.storage_specs()[0]
        await collection.create_indexes([spec.to_model()])

        real = (await collection.index_information())[spec.name]
        fake: Any = FakeAsyncCollection()
        await fake.create_indexes([spec.to_model()])
        mocked = (await fake.index_information())[spec.name]

        assert set(real) == set(mocked)
        assert real["key"] == mocked["key"]
        assert type(real["key"]) is type(mocked["key"])


# The manual-vector mode, which §5.2 promotes to the primary tested vector path because an `autoEmbed`
# index is rejected at creation on every deployment CI can reach. Four dimensions because nothing here
# reads the vectors; the index only has to be real.
MANUAL_VECTOR_CONFIG: MongoDBConfig = {
    "database": "unused",
    "embedding_dimensions": 4,
    "similarity": "cosine",
}


@pytest.mark.integration
class TestSearchIndexesAgainstAtlas:
    """AT-062a/b/c, AT-066, AT-068 — the asynchronous build, which is what no fake can prove.

    Every test here uses the manual-vector mode. That is not a convenience: an ``autoEmbed`` definition
    fails at **creation** on an Atlas local deployment with code 8, *"CanonicalModel: voyage-4-lite not
    registered yet, supported models are: []"*, so the default mode is unreachable here and the
    ``autoembed`` tier exists for it (``O-1``, ``O-3``).
    """

    async def test_a_missing_search_index_is_created_and_reaches_ready(
        self, atlas_database: Any, unique_collection_name: str
    ) -> None:
        """AT-062c, and AT-068 with it: nothing creates the collection first except ``ensure``."""
        collection = atlas_database[unique_collection_name]
        specs = _indexes.memory_search_specs(MANUAL_VECTOR_CONFIG)

        await _indexes.ensure(collection, search=specs, create=True)

        states = {index["name"]: index["status"] async for index in await collection.list_search_indexes()}
        assert states == {spec.name: "READY" for spec in specs}

    async def test_createsearchindexes_needs_the_collection_to_exist(
        self, atlas_database: Any, unique_collection_name: str
    ) -> None:
        """AT-068 / REQ-E-068, the half that makes the ordering load bearing rather than decorative.

        Issued as a raw driver call against a namespace nothing has created. ``createIndexes`` in the
        same position creates the collection implicitly, which is why this asymmetry is easy to miss and
        why it is asserted rather than described.
        """
        from pymongo.errors import OperationFailure

        ghost = atlas_database[f"{unique_collection_name}_ghost"]
        spec = _indexes.memory_search_specs(MANUAL_VECTOR_CONFIG)[0]

        with pytest.raises(OperationFailure) as caught:
            await ghost.create_search_index(spec.to_model())

        assert caught.value.code == 26

    async def test_creating_the_collection_twice_is_not_an_error(
        self, atlas_database: Any, unique_collection_name: str
    ) -> None:
        """``check_exists=False`` on a collection that exists is accepted outright on 8.3.8, so the
        code-48 handler in the module is defense in depth for other server versions rather than a
        branch this deployment reaches. Asserted so the claim is checked rather than assumed."""
        await atlas_database.create_collection(unique_collection_name, check_exists=False)

        await atlas_database.create_collection(unique_collection_name, check_exists=False)

    async def test_a_second_ensure_creates_nothing(self, atlas_database: Any, unique_collection_name: str) -> None:
        """The warm path, which is what every ``initialize()`` after the first one runs. Re-issuing an
        identical definition is in fact accepted by the server, both while building and after ready, so
        this asserts the module does not issue it: a create that succeeds is still a round trip and
        still a write permission the caller may not have."""
        collection = atlas_database[unique_collection_name]
        specs = _indexes.memory_search_specs(MANUAL_VECTOR_CONFIG)
        await _indexes.ensure(collection, search=specs, create=True)
        before = [(index["name"], index["latestVersion"]) async for index in await collection.list_search_indexes()]

        await _indexes.ensure(collection, search=specs, create=True)

        after = [(index["name"], index["latestVersion"]) async for index in await collection.list_search_indexes()]
        assert after == before

    async def test_verify_only_reports_a_missing_search_index_with_its_command(
        self, atlas_database: Any, unique_collection_name: str
    ) -> None:
        """AT-062a / REQ-E-061, REQ-E-062. *Missing* is the state whose remedy is to create, so the
        message carries the creation command and the collection is left untouched."""
        from strands.types.exceptions import StorageError

        collection = atlas_database[unique_collection_name]
        specs = _indexes.memory_search_specs(MANUAL_VECTOR_CONFIG)

        with pytest.raises(StorageError) as caught:
            await _indexes.ensure(collection, search=specs, create=False)

        message = str(caught.value)
        assert "createSearchIndex" in message
        assert unique_collection_name not in await atlas_database.list_collection_names()

    async def test_a_building_index_is_distinguished_from_a_ready_one(
        self, atlas_database: Any, unique_collection_name: str
    ) -> None:
        """AT-062b, the one that needs care: catching an index mid-build is a race.

        Locally ``READY`` arrives in about 0.25s, and polling immediately after ``create_search_index``
        reliably observes a non-ready status. Reliably is not always, so the whole scenario retries
        three times on a fresh collection and then **skips with a reason** rather than failing. A flaky
        assertion about a race teaches the reader to rerun the suite until it is green, which is worse
        than an honest skip.
        """
        for attempt in range(3):
            collection = atlas_database[f"{unique_collection_name}_{attempt}"]
            spec = _indexes.memory_search_specs(MANUAL_VECTOR_CONFIG)[0]
            await atlas_database.create_collection(collection.name, check_exists=False)
            await collection.create_search_index(spec.to_model())

            observed = [index["status"] async for index in await collection.list_search_indexes(spec.name)]
            if observed and observed[0] != "READY":
                # The state the requirement is about, reached on a real deployment. The package must
                # wait it out rather than reporting it as missing or as ready.
                assert _indexes.readiness(observed[0]) == "building"
                await _indexes.ensure(collection, search=[spec], create=False)
                return

        pytest.skip(
            "the vector index reached READY before the first poll on all 3 attempts, so the building "
            "state was not observable on this deployment"
        )

    async def test_polling_a_real_build_leaves_the_event_loop_running(
        self, atlas_database: Any, unique_collection_name: str
    ) -> None:
        """AT-066 / REQ-E-066. The reference helpers poll with a blocking ``time.sleep``, which in an
        agent process stalls every other coroutine on the loop for as long as the build takes. Asserted
        against a real build rather than a programmed one, because the interval that matters is the one
        the module chose and not the ``0`` the unit tier passes."""
        collection = atlas_database[unique_collection_name]
        specs = _indexes.memory_search_specs(MANUAL_VECTOR_CONFIG)
        ticks = 0

        async def tick() -> None:
            nonlocal ticks
            while True:
                ticks += 1
                await asyncio.sleep(0.01)

        ticker = asyncio.create_task(tick())
        try:
            await _indexes.ensure(collection, search=specs, create=True)
        finally:
            ticker.cancel()

        assert ticks > 1

    async def test_the_real_cursor_yields_the_keys_the_fake_promises(
        self, atlas_database: Any, unique_collection_name: str
    ) -> None:
        """MP-002's behavioural half. The unit tier reads ``name``, ``status``, ``latestDefinition`` and
        ``statusDetail`` off programmed dicts; this is what fails if the server stops sending them."""
        collection = atlas_database[unique_collection_name]
        specs = _indexes.memory_search_specs(MANUAL_VECTOR_CONFIG)
        await _indexes.ensure(collection, search=specs, create=True)

        documents = [index async for index in await collection.list_search_indexes()]

        assert documents
        for document in documents:
            assert {"name", "status", "queryable", "latestDefinition", "type"} <= set(document)

    async def test_the_vector_definition_the_server_reports_back_is_the_one_we_sent(
        self, atlas_database: Any, unique_collection_name: str
    ) -> None:
        """One half of what the comparison in ``ensure`` rests on, and the half that holds.

        A ``vectorSearch`` definition round-trips byte for byte, so every key of it is comparable
        directly. Asserted here rather than assumed, because it is what makes a wrong ``numDimensions``
        detectable at all.
        """
        collection = atlas_database[unique_collection_name]
        spec = _indexes.memory_search_specs(MANUAL_VECTOR_CONFIG)[0]
        await _indexes.ensure(collection, search=[spec], create=True)

        documents = [index async for index in await collection.list_search_indexes(spec.name)]

        assert documents[0]["latestDefinition"] == spec.definition

    async def test_the_text_definition_comes_back_rewritten_which_is_why_covering_is_not_equality(
        self, atlas_database: Any, unique_collection_name: str
    ) -> None:
        """The other half, and the reason ``REQ-E-069`` exists.

        This test began as one equality assertion over ``specs[0]`` and passed. The same assertion over
        ``specs[1]`` fails: mongot collapses the one-element list into the object it held and adds
        ``indexOptions``, ``store`` and ``norms``. Both facts are asserted here so the asymmetry is a
        measurement rather than a remark, and so a server that ever stops rewriting is a visible change
        rather than a silently loosened comparison.
        """
        collection = atlas_database[unique_collection_name]
        spec = _indexes.memory_search_specs(MANUAL_VECTOR_CONFIG)[1]
        await _indexes.ensure(collection, search=[spec], create=True)

        reported = [index async for index in await collection.list_search_indexes(spec.name)][0]["latestDefinition"]

        assert reported != spec.definition
        mapped = reported["mappings"]["fields"]["content"]
        assert not isinstance(mapped, list)
        assert mapped["type"] == "string"
        assert _indexes._definition_gap(spec.definition, reported) is None
