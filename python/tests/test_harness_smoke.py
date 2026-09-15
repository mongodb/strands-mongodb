"""The thinnest live test that proves the harness reaches a real deployment.

Bootstrap phase requirement: one test that crosses the riskiest boundary for real before anything is
built on top of the fixtures. The risk here is not the package, which does not exist yet. It is the
harness: a ``contract_database`` fixture that silently yields a handle to nothing would let every
contract test in Tasks 4 through 9 pass against a database that was never written to.

Crosses **B-1** (in-process to ``mongod`` over the wire) and **B-3** (the mock-to-real boundary, in
the trivial direction where no mock is involved yet).

These tests assert the harness, not the package. They stay small on purpose and are not part of any
requirement's acceptance.
"""

from __future__ import annotations

from typing import Any

import pytest


@pytest.mark.contract
class TestContractFixtureReachesARealServer:
    """``contract_database`` yields a handle that round-trips a document."""

    async def test_server_answers_a_ping(self, contract_database: Any) -> None:
        """The deployment is reachable and speaks the wire protocol.

        Separate from the write test so a connection failure and a write failure are distinguishable
        in the report. Debugging a single combined failure means guessing which half broke.
        """
        result = await contract_database.command("ping")

        assert result["ok"] == 1

    async def test_document_round_trips(self, contract_database: Any, unique_collection_name: str) -> None:
        """A write is durable and readable, and the bytes survive.

        ``Binary`` is used rather than a plain string because the storage collection stores payloads
        as BSON ``Binary`` (§6.6), and the round trip that matters is the one the package will
        actually perform.
        """
        from bson import Binary

        collection = contract_database[unique_collection_name]
        payload = bytes(range(256))

        await collection.replace_one({"_id": "harness/smoke"}, {"data": Binary(payload)}, upsert=True)
        document = await collection.find_one({"_id": "harness/smoke"})

        assert document is not None
        assert bytes(document["data"]) == payload

    async def test_writes_land_in_this_sessions_database(
        self, contract_database: Any, test_database_name: str, unique_collection_name: str
    ) -> None:
        """The fixture writes to the throwaway database, not to a real one.

        The failure this prevents is not subtle in effect and is very subtle in appearance: a
        misconfigured fixture writing to whatever database the connection string names, then dropping
        it on teardown. A test suite that deletes the developer's data passes every assertion while
        doing it.
        """
        collection = contract_database[unique_collection_name]
        await collection.insert_one({"_id": "harness/where-am-i"})

        assert contract_database.name == test_database_name
        assert test_database_name.startswith("strands_mongodb_test_")

        names = await contract_database.client.list_database_names()
        assert test_database_name in names


@pytest.mark.integration
class TestIntegrationFixtureReachesSearch:
    """``atlas_database`` yields a handle on a deployment where ``mongot`` is present."""

    async def test_search_index_commands_are_available(self, atlas_database: Any, unique_collection_name: str) -> None:
        """``list_search_indexes`` succeeds, which a plain ``mongod`` cannot do.

        This is the assertion that separates the integration tier from the contract tier. Without
        it, pointing ``MONGODB_ATLAS_URI`` at a plain ``mongod`` would run the whole integration
        suite against a deployment with no search support, and the vector tests would return empty
        results rather than errors (premortem **P-2**, observed live during the §10.2 probe).
        """
        collection = atlas_database[unique_collection_name]
        await collection.insert_one({"_id": "harness/search-probe", "content": "hello"})

        indexes = [index async for index in await collection.list_search_indexes()]

        # A fresh collection has no search indexes. The point is that the command answers at all.
        assert indexes == []
