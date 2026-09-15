"""Connection resolution, ownership and lifecycle: ``REQ-E-010`` through ``REQ-E-017``.

Everything here is about the client, not about queries, so almost none of it needs a database.
``AsyncMongoClient`` construction performs no I/O and validates nothing (verified on pymongo 4.17.0:
``AsyncMongoClient("not-a-uri-at-all")`` succeeds, reading the string as a hostname), which is what
lets the ownership, registry and attribution tests run in the mock tier at full speed.

Two tests do need a real deployment, and for opposite reasons. ``AT-011`` has to observe that a
closed client actually refuses work, and ``AT-017`` has to run two real event loops. Neither can be
faked without asserting the fake.
"""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING, Any

import pytest
from pymongo import AsyncMongoClient
from pymongo.driver_info import DriverInfo

from strands_mongodb import _client

if TYPE_CHECKING:
    from strands_mongodb.types import MongoDBConfig

# A password that no other string in the suite contains, so a sweep for it cannot match by accident.
LEAKY_URI = "mongodb://appuser:SUPERSECRET@db.example.com:27017/appdb"


async def _is_closed(client: AsyncMongoClient[Any]) -> bool:
    """Report whether a client has been closed, by observing it rather than reading a flag.

    ``client._closed`` would answer this in one attribute, and it is private. What a *caller* sees is
    ``InvalidOperation: Cannot use AsyncMongoClient after close``, raised before any network attempt,
    so a probe against a dead port separates the two states without a database and without a wait: a
    live client reaches server selection and times out, a closed one never gets there.

    Args:
        client: The client to probe. It is left in whatever state it was already in.

    Returns:
        ``True`` if the client refuses work because it was closed.
    """
    from pymongo.errors import InvalidOperation

    try:
        await client.admin.command("ping")
    except InvalidOperation:
        return True
    except Exception:  # noqa: BLE001 - any other failure means the client was still willing to try
        return False
    return False


@pytest.fixture(autouse=True)
def _clear_registry() -> Any:
    """Empty the module-level registry around every test.

    The registry is process-global by design (``REQ-E-012``), which makes it shared mutable state
    between tests. Clearing it before *and* after means a test never inherits a client another test
    created, and a test that leaves one behind cannot make a later assertion about identity pass for
    the wrong reason.

    Reaching into ``_REGISTRY`` is deliberate. The alternative is a ``reset_registry()`` helper in
    ``_client.py``, which would be a function shipped to users that exists only for this fixture. A
    private module's private dict is the more honest seam: it reads as a test touching internals,
    because that is what it is.
    """
    _client._REGISTRY.clear()
    yield
    _client._REGISTRY.clear()


class TestConstructionRequiresAWayToReachTheDatabase:
    """AT-015 / REQ-E-015 — the error that has to arrive before anything else does.

    Nothing upstream raises here. On pymongo 4.17.0 a string with no scheme is read as a hostname and
    an unresolvable host is not an error until an operation runs, so without this check a config
    missing its connection string surfaces as a server-selection timeout against ``localhost`` some
    seconds later, in a stack frame that names neither field.
    """

    def test_neither_client_nor_connection_string_raises_value_error(self) -> None:
        """The `IF` half of ``REQ-E-015``."""
        with pytest.raises(ValueError) as caught:
            _client.resolve({"database": "appdb"})

        assert isinstance(caught.value, ValueError)

    def test_the_message_names_both_fields_the_caller_could_have_set(self) -> None:
        """ "Missing configuration" tells the reader nothing they did not already know.

        Both names, because either one fixes it, and a message naming only ``connection_string``
        pushes a caller who already holds an ``AsyncMongoClient`` toward building a second one.
        """
        with pytest.raises(ValueError, match="connection_string") as caught:
            _client.resolve({"database": "appdb"})

        assert "client" in str(caught.value)

    def test_the_message_is_attributed_to_this_package(self) -> None:
        """House style from ``BedrockKnowledgeBaseStore``: the class or module leads the message.

        A bare ``ValueError`` about a missing key, arriving from inside an ``Agent`` construction that
        touches several backends, does not say which one is unhappy.
        """
        with pytest.raises(ValueError, match="strands.mongodb|MongoDB"):
            _client.resolve({"database": "appdb"})

    def test_no_client_is_registered_by_a_rejected_config(self) -> None:
        """The `before any I/O` half, asserted through the registry rather than by timing.

        A rejected config that still left a registry entry behind would mean the constructor got far
        enough to build something, which is the failure this clause exists to prevent.
        """
        with pytest.raises(ValueError):
            _client.resolve({"database": "appdb"})

        assert _client._REGISTRY == {}


class TestOwnershipDecidesWhoMayClose:
    """AT-010, AT-011 / REQ-E-010, REQ-E-011 — the asymmetry the plan calls out at line 803.

    The defect in the reference implementation was one line: ``close()`` calling
    ``self.client.close()`` unconditionally. In an agent process a single ``AsyncMongoClient`` is
    typically shared across memory, storage and the application's own queries, so closing an injected
    one tears down a pool three unrelated subsystems are still using. The bug does not show up in the
    closing component. It shows up somewhere else, later.
    """

    async def test_an_injected_client_survives_our_close(self) -> None:
        """REQ-E-010 — `SHALL NOT close it, at any point, including on its own close()`."""
        injected: AsyncMongoClient[Any] = AsyncMongoClient("mongodb://127.0.0.1:1/", serverSelectionTimeoutMS=50)
        config: MongoDBConfig = {"database": "appdb", "client": injected}

        _client.resolve(config)
        await _client.close(config)

        assert await _is_closed(injected) is False

    async def test_an_injected_client_survives_close_called_twice(self) -> None:
        """Idempotence on the path where a mistake is unrecoverable.

        ``close()`` is the kind of method that gets called from a ``finally`` and again from an
        ``atexit``. The second call must not find a reason to close what the first one correctly left
        alone, and it must not raise for a config it no longer has an entry for.
        """
        injected: AsyncMongoClient[Any] = AsyncMongoClient("mongodb://127.0.0.1:1/", serverSelectionTimeoutMS=50)
        config: MongoDBConfig = {"database": "appdb", "client": injected}

        _client.resolve(config)
        await _client.close(config)
        await _client.close(config)

        assert await _is_closed(injected) is False

    async def test_closing_a_config_that_never_resolved_is_a_no_op(self) -> None:
        """``close()`` runs on the unhappy path, so it must not raise on a config ``resolve`` rejected.

        The realistic shape is a ``try``/``finally`` around construction: ``resolve`` raises
        ``ValueError`` for a config missing both connection fields, and the ``finally`` calls ``close``
        on that same config. A ``close`` that re-raised there would replace the actionable
        ``REQ-E-015`` message with a second copy of itself thrown from teardown.
        """
        await _client.close({"database": "appdb"})

        assert _client._REGISTRY == {}

    async def test_a_client_we_constructed_is_closed_by_our_close(self) -> None:
        """REQ-E-011 — the other half, which the same ownership flag has to get right.

        Written alongside the injected case on purpose. A ``close()`` that closes nothing passes every
        assertion above while leaking a connection pool per store.
        """
        config: MongoDBConfig = {
            "database": "appdb",
            "connection_string": "mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=50",
        }
        connection = _client.resolve(config)

        await _client.close(config)

        assert await _is_closed(connection.client) is True

    def test_ownership_is_recorded_from_which_field_supplied_the_client(self) -> None:
        """The flag itself, because the two tests above cannot distinguish `right` from `lucky`.

        A ``close()`` hardcoded to never close passes the injected tests; one hardcoded to always
        close passes the constructed test. This is the field that has to carry the difference.
        """
        injected: AsyncMongoClient[Any] = AsyncMongoClient("mongodb://127.0.0.1:1/")

        assert _client.resolve({"database": "appdb", "client": injected}).owned is False
        assert _client.resolve({"database": "appdb", "connection_string": "mongodb://127.0.0.1:2/"}).owned is True

    def test_an_injected_client_wins_over_a_connection_string(self) -> None:
        """REQ-E-010's `WHEN the caller supplies client` outranks REQ-E-011's `WHILE client is absent`.

        Both fields set is not an error, and it is not far-fetched: a config assembled from a
        template's defaults plus a caller's override arrives exactly this way. The client the caller
        handed us is the one they expect their queries to run on.
        """
        injected: AsyncMongoClient[Any] = AsyncMongoClient("mongodb://127.0.0.1:1/")
        config: MongoDBConfig = {
            "database": "appdb",
            "client": injected,
            "connection_string": "mongodb://127.0.0.1:2/",
        }

        connection = _client.resolve(config)

        assert connection.client is injected
        assert connection.owned is False


class TestOneClientPerConnectionIdentity:
    """AT-012 / REQ-E-012 — §8.2 property 2, and the reason it is a property and not a nicety.

    A ``Storage`` reaches five SDK subsystems and a ``MemoryStore`` is registered per memory surface,
    so one agent can construct a double-digit number of these from the same config. Each
    ``AsyncMongoClient`` carries its own connection pool, defaulting to 100 sockets, plus a topology
    monitor per server. Without sharing, a config that reads like one database connection becomes
    however many the wiring happened to produce.
    """

    def test_a_hundred_resolutions_of_one_config_yield_one_client(self) -> None:
        """The count from ``tasks.md``, asserted on object identity rather than on a cache-hit counter."""
        config: MongoDBConfig = {"database": "appdb", "connection_string": "mongodb://127.0.0.1:1/"}

        clients = {id(_client.resolve(config).client) for _ in range(100)}

        assert len(clients) == 1

    def test_separate_config_dicts_with_the_same_connection_string_still_share(self) -> None:
        """`same connection identity`, not `same dict`.

        Each store is configured from its own literal, so identity keyed on the config object would
        share nothing in the case the requirement is about. This is the test that fails if the registry
        is keyed on ``id(config)``.

        Both dicts are bound to names and kept alive, which is the only reason this test can detect
        that. Passed as temporaries, the first is freed as soon as ``resolve`` returns and CPython
        hands the second its address, so ``id(config)`` collides by accident and a registry keyed on it
        passes. Found by mutation: the version of this test without the local variables did pass
        against exactly that implementation.
        """
        first_config: MongoDBConfig = {"database": "appdb", "connection_string": "mongodb://127.0.0.1:1/"}
        second_config: MongoDBConfig = {"database": "otherdb", "connection_string": "mongodb://127.0.0.1:1/"}

        first = _client.resolve(first_config)
        second = _client.resolve(second_config)

        assert id(first_config) != id(second_config), "the configs must be distinct objects for this to mean anything"
        assert first.client is second.client

    def test_different_connection_strings_do_not_share(self) -> None:
        """The negative half. A registry with one global entry passes every test above."""
        first = _client.resolve({"database": "appdb", "connection_string": "mongodb://127.0.0.1:1/"})
        second = _client.resolve({"database": "appdb", "connection_string": "mongodb://127.0.0.1:2/"})

        assert first.client is not second.client

    def test_the_same_uri_with_different_client_args_does_not_share(self) -> None:
        """``client_args`` is part of the identity, and this is the test that says so.

        Added after a mutation that dropped ``client_args`` from the digest survived the whole suite.
        ``_identity``'s docstring already claimed the behavior and the code already implemented it, so
        the gap was invisible to review: the claim was simply unasserted.

        What the mutation would have shipped is a silent misconfiguration rather than a crash. The
        second config hits the cache, its arguments are discarded, and the caller gets a client with
        someone else's timeouts. Asserted on the timeout that reaches ``client.options``, not only on
        object identity, because sharing is the failure and the wrong timeout is the symptom a user
        would eventually report.
        """
        uri = "mongodb://127.0.0.1:1/"
        patient: MongoDBConfig = {
            "database": "appdb",
            "connection_string": uri,
            "client_args": {"connectTimeoutMS": 20000},
        }
        impatient: MongoDBConfig = {
            "database": "appdb",
            "connection_string": uri,
            "client_args": {"connectTimeoutMS": 500},
        }

        first = _client.resolve(patient)
        second = _client.resolve(impatient)

        assert first.client is not second.client
        assert first.client.options.pool_options.connect_timeout == 20.0
        assert second.client.options.pool_options.connect_timeout == 0.5

    def test_client_args_and_no_client_args_are_different_identities(self) -> None:
        """The boundary case the digest has to get right: ``{}`` and absent must key the same.

        ``config.get("client_args") or {}`` collapses both to the same JSON, which is deliberate. An
        empty dict asks for nothing, so it describes the same client as omitting the key, and treating
        them apart would build a second pool for a config that differs only in verbosity.
        """
        uri = "mongodb://127.0.0.1:1/"
        absent = _client.resolve({"database": "appdb", "connection_string": uri})
        empty = _client.resolve({"database": "appdb", "connection_string": uri, "client_args": {}})
        populated = _client.resolve(
            {"database": "appdb", "connection_string": uri, "client_args": {"connectTimeoutMS": 500}}
        )

        assert absent.client is empty.client
        assert populated.client is not absent.client

    def test_two_injected_clients_are_kept_apart_by_identity(self) -> None:
        """Injected clients key on ``id(client)``, per §4.1.

        Two callers can inject two clients built from the same URI, and they are not
        interchangeable: they may differ in credentials, read preference, or timeouts, none of which
        the registry inspects. Deduplicating them would hand one caller the other's client.
        """
        first_client: AsyncMongoClient[Any] = AsyncMongoClient("mongodb://127.0.0.1:1/")
        second_client: AsyncMongoClient[Any] = AsyncMongoClient("mongodb://127.0.0.1:1/")

        first = _client.resolve({"database": "appdb", "client": first_client})
        second = _client.resolve({"database": "appdb", "client": second_client})

        assert first.client is first_client
        assert second.client is second_client
        assert len(_client._REGISTRY) == 2

    def test_closing_one_config_releases_its_registry_entry(self) -> None:
        """A registry that only ever grows is a leak, and it also breaks reuse after ``close()``.

        The entry has to go, so a later ``resolve`` of the same config builds a fresh client rather
        than handing back the closed one.
        """
        config: MongoDBConfig = {"database": "appdb", "connection_string": "mongodb://127.0.0.1:1/"}
        first = _client.resolve(config)

        asyncio.run(_client.close(config))
        second = _client.resolve(config)

        assert second.client is not first.client


class TestDriverAttributionReachesTheServer:
    """AT-013a, AT-013b / REQ-E-013 — CORE-4, and the API the plan named does not exist.

    Attribution is how MongoDB counts Strands usage in server logs and Atlas telemetry, so a silent
    failure here is invisible to us and to the user both.

    ``REQ-E-013`` originally named ``append_client_metadata``. That function is real, but it lives in
    ``pymongo_search_utils``, which the ``[storage]`` extra does not install, and ``_client.py`` is
    shared with ``storage.py``. Its entire body is a ``callable()`` guard around
    ``client.append_metadata``, so these tests assert the guarded call and the metadata it produces.
    """

    def test_a_client_we_construct_carries_the_attribution(self) -> None:
        """AT-013a — asserted on the resulting metadata, not on the call.

        ``driver`` is not a named parameter of ``AsyncMongoClient.__init__``. It arrives through
        ``**kwargs``, so no type checker and no signature inspection will catch it being misspelled,
        renamed upstream, or dropped. The pool metadata is the only thing that actually proves it
        landed.
        """
        connection = _client.resolve({"database": "appdb", "connection_string": "mongodb://127.0.0.1:1/"})

        metadata = connection.client.options.pool_options.metadata

        assert "Strands" in metadata["driver"]["name"]

    def test_the_attribution_extends_pymongos_own_rather_than_replacing_it(self) -> None:
        """The metadata is a pipe-delimited chain, and PyMongo's own entry has to stay in it.

        Overwriting it would misreport the driver to the server, which is worse than sending nothing:
        it makes a Strands install look like it is not using PyMongo at all.
        """
        connection = _client.resolve({"database": "appdb", "connection_string": "mongodb://127.0.0.1:1/"})

        name = connection.client.options.pool_options.metadata["driver"]["name"]

        assert name.startswith("PyMongo")
        assert name.endswith("Strands")

    def test_the_driver_name_is_exactly_strands(self) -> None:
        """The name is a data key, not a label, so it is pinned rather than merely searched for.

        Every assertion above uses ``in`` or ``endswith``, which all pass on ``StrandsMongoDB`` or
        ``strands``. Server logs and Atlas telemetry group by this string, and the comparison in
        ``_update_metadata`` is case-insensitive but exact otherwise, so changing it orphans every
        record collected under the old one.

        The ``DriverInfo`` type is asserted alongside it because ``append_metadata`` raises ``TypeError``
        on anything else, and the injected path passes it through unexamined.
        """
        info = _client._driver_info()

        assert isinstance(info, DriverInfo)
        assert info.name == "Strands"

    def test_the_reported_version_is_the_installed_package_version(self) -> None:
        """A version pinned to a literal would report the release it was typed in, forever."""
        from importlib.metadata import version

        connection = _client.resolve({"database": "appdb", "connection_string": "mongodb://127.0.0.1:1/"})

        versions = connection.client.options.pool_options.metadata["driver"]["version"]

        assert versions.endswith(version("strands-mongodb"))

    def test_an_injected_client_is_attributed_through_append_metadata(self) -> None:
        """AT-013b — the second path, which is the only one available for a client we did not build."""
        injected: AsyncMongoClient[Any] = AsyncMongoClient("mongodb://127.0.0.1:1/")

        _client.resolve({"database": "appdb", "client": injected})

        assert "Strands" in injected.options.pool_options.metadata["driver"]["name"]

    def test_repeated_attribution_of_one_client_is_idempotent(self) -> None:
        """A characterization test of pymongo, not an assertion about our control flow.

        Labeled that way because it cannot fail on anything we write, and a reader is entitled to know
        which tests are load bearing. Confirmed by mutation: removing the cache-hit early return from
        ``resolve`` leaves this passing.

        ``PoolOptions._update_metadata`` returns early when the name is already in the pipe-delimited
        chain, comparing case-insensitively, so appending ``Strands`` twice is a no-op and only a
        different name stacks. The spec asserted the opposite until this was read rather than inferred.

        Kept because we rely on it. Resolving one config repeatedly is the normal case
        (``REQ-E-012``), and if a future pymongo drops the dedupe, the attribution string starts
        growing once per store and this is the test that says so.
        """
        injected: AsyncMongoClient[Any] = AsyncMongoClient("mongodb://127.0.0.1:1/")
        config: MongoDBConfig = {"database": "appdb", "client": injected}

        for _ in range(5):
            _client.resolve(config)

        name = injected.options.pool_options.metadata["driver"]["name"]

        assert name.count("Strands") == 1

    def test_a_pymongo_without_append_metadata_logs_at_info_instead_of_failing(
        self, caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """AT-013b's second half — the silent no-op, made audible.

        Below pymongo 4.14 ``append_metadata`` is not a method. It resolves through
        ``AsyncMongoClient.__getattr__`` to a ``Database`` of that name, which is truthy and not
        callable, so an unguarded call raises ``TypeError`` and a guarded one does nothing at all.
        Our declared floor is 4.12, so this is a supported install, not a hypothetical.

        Simulated by replacing the attribute with a non-callable, which is exactly the shape the old
        pymongo presents. The installed 4.17.0 cannot reproduce it otherwise.
        """
        injected: AsyncMongoClient[Any] = AsyncMongoClient("mongodb://127.0.0.1:1/")
        monkeypatch.setattr(type(injected), "append_metadata", "not a method", raising=False)

        with caplog.at_level(logging.INFO, logger="strands_mongodb"):
            _client.resolve({"database": "appdb", "client": injected})

        assert any(record.levelno == logging.INFO for record in caplog.records), caplog.records
        assert "4.14" in caplog.text


class TestRetryWritesDisabledIsWorthSaying:
    """AT-016 / REQ-E-016 — §11.4, a warning rather than a refusal.

    The upsert shapes in ``storage.py`` are idempotent precisely so that the driver's own retry can
    replay them. Turning ``retryWrites`` off does not corrupt anything; it removes the layer that
    absorbs a primary stepdown, and the write surfaces to the caller instead. That is a legitimate
    choice, so this warns and proceeds.

    Read from ``client.options.retry_writes`` rather than parsed out of the connection string. See the
    widening recorded on ``REQ-E-016``: it catches the setting whether it came from the URI, from
    ``client_args``, or from a client the caller injected, and it means we ship no URI parser.
    """

    def test_a_connection_string_disabling_retries_warns(self, caplog: pytest.LogCaptureFixture) -> None:
        """The URI route, which is the one the requirement was written about."""
        with caplog.at_level(logging.WARNING, logger="strands_mongodb"):
            _client.resolve({"database": "appdb", "connection_string": "mongodb://127.0.0.1:1/?retryWrites=false"})

        assert "retryWrites" in caplog.text

    def test_the_warning_says_what_the_consequence_is(self, caplog: pytest.LogCaptureFixture) -> None:
        """A warning that only restates the setting gives the reader nothing to decide with.

        They set it deliberately. What they may not know is that this package's write shapes were
        designed around the retry it removes.
        """
        with caplog.at_level(logging.WARNING, logger="strands_mongodb"):
            _client.resolve({"database": "appdb", "connection_string": "mongodb://127.0.0.1:1/?retryWrites=false"})

        assert "retr" in caplog.text.lower()
        assert len(caplog.text) > 60, caplog.text

    def test_client_args_disabling_retries_warns_too(self, caplog: pytest.LogCaptureFixture) -> None:
        """The route the original wording missed, and the reason the requirement was widened."""
        with caplog.at_level(logging.WARNING, logger="strands_mongodb"):
            _client.resolve(
                {
                    "database": "appdb",
                    "connection_string": "mongodb://127.0.0.1:1/",
                    "client_args": {"retryWrites": False},
                }
            )

        assert "retryWrites" in caplog.text

    def test_an_injected_client_with_retries_disabled_warns(self, caplog: pytest.LogCaptureFixture) -> None:
        """The hazard does not depend on who built the client."""
        injected: AsyncMongoClient[Any] = AsyncMongoClient("mongodb://127.0.0.1:1/", retryWrites=False)

        with caplog.at_level(logging.WARNING, logger="strands_mongodb"):
            _client.resolve({"database": "appdb", "client": injected})

        assert "retryWrites" in caplog.text

    def test_a_shared_config_warns_once_no_matter_how_many_stores_resolve_it(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """One warning per connection, not one per store, which is what makes it readable.

        A ``Storage`` reaches five SDK subsystems, so the same config is resolved many times over one
        agent's construction. A hundred identical warnings in the log is the same as none: the reader
        scrolls past them.

        This is the assertion the cache-hit early return in ``resolve`` actually protects. The
        attribution it also skips turns out to be idempotent anyway (see
        ``test_repeated_attribution_of_one_client_is_idempotent``), so without this test nothing would
        fail if that early return were deleted.
        """
        config: MongoDBConfig = {
            "database": "appdb",
            "connection_string": "mongodb://127.0.0.1:1/?retryWrites=false",
        }

        with caplog.at_level(logging.WARNING, logger="strands_mongodb"):
            for _ in range(100):
                _client.resolve(config)

        assert len([r for r in caplog.records if "retryWrites" in r.getMessage()]) == 1

    def test_the_default_configuration_warns_about_nothing(self, caplog: pytest.LogCaptureFixture) -> None:
        """A warning every user sees on a correct config is noise, and it trains them to filter us out."""
        with caplog.at_level(logging.WARNING, logger="strands_mongodb"):
            _client.resolve({"database": "appdb", "connection_string": "mongodb://127.0.0.1:1/"})

        assert caplog.records == []


class TestThePasswordNeverLeavesTheConfig:
    """AT-014 / REQ-E-014 — premortem **P-3**, and the test that keeps it closed.

    ``MongoDBConfig`` is a plain ``dict`` holding a URI with an inline password. Every ordinary Python
    habit leaks it: an f-string over the config in a debug line, a ``KeyError`` naming the key it
    could not find, a dataclass ``__repr__`` that includes the field, a traceback capturing locals.
    None of those is a bug anyone writes on purpose, which is why the guard has to be a test rather
    than a review note.

    Checked what pymongo already handles, so this asserts only what is ours: ``repr`` of an
    ``AsyncMongoClient`` built from ``LEAKY_URI`` prints ``host=['db.example.com:27017']`` and no
    password, and an invalid URI option raises no exception to leak into.

    Scope note: ``tasks.md`` specifies this sweep across all five ``Storage`` methods and both memory
    methods. Those methods are Tasks 5 through 8. :func:`assert_no_leak` is written to be extended
    there, and the sweep here covers every surface that exists at Task 2.
    """

    @staticmethod
    def assert_no_leak(*subjects: object) -> None:
        """Assert the password appears in none of the given renderings.

        Args:
            *subjects: Objects whose ``repr`` must not contain the password, plus any strings to check
                directly. Strings are checked as themselves rather than as their ``repr``, so a log
                record or an exception message can be passed straight in.

        Raises:
            AssertionError: Naming the leaking subject, without reproducing the password in the
                failure message, which would leak it into CI output.
        """
        for index, subject in enumerate(subjects):
            text = subject if isinstance(subject, str) else repr(subject)
            assert "SUPERSECRET" not in text, f"subject {index} ({type(subject).__name__}) leaked the password"

    def test_resolving_a_leaky_config_logs_no_password_at_debug(self, caplog: pytest.LogCaptureFixture) -> None:
        """DEBUG, because that is the level whose whole purpose is saying more than usual.

        A package that redacts at ``info`` and interpolates the config at ``debug`` has not solved
        this. Debug logging is enabled precisely when something is already going wrong, which is when
        the logs get pasted into a ticket.
        """
        config: MongoDBConfig = {"database": "appdb", "connection_string": LEAKY_URI}

        with caplog.at_level(logging.DEBUG, logger="strands_mongodb"):
            _client.resolve(config)

        self.assert_no_leak(caplog.text)

    def test_a_leaky_config_that_also_disables_retries_redacts_the_warning(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """The one log line ``_client.py`` is *required* to emit, on a config that carries a secret.

        ``REQ-E-016`` and ``REQ-E-014`` meet here, and the natural way to write the warning is to
        include the connection string so the reader knows which client it is about.
        """
        config: MongoDBConfig = {"database": "appdb", "connection_string": f"{LEAKY_URI}?retryWrites=false"}

        with caplog.at_level(logging.DEBUG, logger="strands_mongodb"):
            _client.resolve(config)

        assert "retryWrites" in caplog.text
        self.assert_no_leak(caplog.text)

    def test_nothing_the_registry_holds_renders_the_password(self) -> None:
        """The registry key is the live hazard, because §4.1 makes it the connection string.

        A ``dict`` keyed on a URI leaks on ``repr(registry)``, in a ``KeyError``, and in any debugger
        or crash reporter that walks module globals. The identity semantics ``REQ-E-012`` needs
        survive a digest of the string, so the key does not have to be the string itself.

        ``_Connection`` is a dataclass, so its generated ``__repr__`` prints every field it has. This
        is the assertion that fails if a future field holds the URI.
        """
        config: MongoDBConfig = {"database": "appdb", "connection_string": LEAKY_URI}
        connection = _client.resolve(config)

        self.assert_no_leak(connection, _client._REGISTRY, *_client._REGISTRY.keys())

    def test_a_client_pymongo_refuses_to_build_is_reported_without_the_password(self) -> None:
        """Exception messages, on the one failure ``resolve`` can hit while holding a live URI.

        ``client_args`` is forwarded to ``AsyncMongoClient`` unvalidated, so a bad entry raises from
        inside our own call. pymongo's own message does not echo the URI (checked: ``bogusOption``
        yields ``Unknown option: bogusOption``), which is what makes this a test of our handling rather
        than of theirs: the risk is a wrapper that adds context by interpolating the config.
        """
        config: Any = {"database": "appdb", "connection_string": LEAKY_URI, "client_args": {"bogusOption": 1}}

        with pytest.raises(Exception) as caught:  # noqa: PT011 - the type is pymongo's to choose
            _client.resolve(config)

        self.assert_no_leak(str(caught.value), caught.value)

    def test_the_traceback_of_a_failed_construction_holds_no_password(self) -> None:
        """Locals travel with a traceback, which is what makes this hard to get right by inspection.

        Any frame between the caller and the raise that binds the URI to a name puts it in the
        traceback, and from there into every crash reporter the user runs with locals enabled.

        The ``else`` clause is not decoration. An earlier version of this test used a config nothing
        rejects, so the ``except`` body never ran and it passed while asserting nothing at all.
        """
        import traceback

        config: Any = {"database": "appdb", "connection_string": LEAKY_URI, "client_args": {"bogusOption": 1}}

        try:
            _client.resolve(config)
        except Exception as error:
            self.assert_no_leak("".join(traceback.format_exception(error)))
        else:
            pytest.fail("expected pymongo to reject client_args={'bogusOption': 1}")

    def test_the_password_is_not_in_the_module_logger_name_or_any_handler_state(self) -> None:
        """A cheap sweep over what the module keeps at rest, after a leaky config has been through it.

        ``repr`` of a module's globals is what a traceback renderer, a memory dump, or an error
        reporter with ``include_locals`` will walk.
        """
        _client.resolve({"database": "appdb", "connection_string": LEAKY_URI})

        self.assert_no_leak(*(value for value in vars(_client).values() if not callable(value)))


class TestTheLockFollowsTheEventLoop:
    """AT-017 / REQ-E-017 — boundary **B-8**, and a failure mode worse than the requirement implies.

    A synchronous ``Agent`` runs each invocation on a fresh event loop, so a lock created during the
    first invocation is asked to work during the second on a loop that no longer exists.

    Two things about this are sharper than ``REQ-E-017`` states, both verified on 3.14.5:

    * **It only bites under contention.** ``asyncio.Lock`` has bound its loop lazily since 3.10:
      ``acquire()`` on an unlocked lock returns without calling ``_get_loop()``, so an uncontended
      lock crosses loops silently. A test that acquires it once per loop passes against a completely
      broken implementation. Both halves below therefore force a waiter.
    * **It does not recover.** The ``RuntimeError`` is raised after ``self._locked`` is already set,
      so the failing lock is left locked forever and every later invocation fails too. The
      user-visible symptom is an agent that works once and then hangs or raises on every subsequent
      call, which reads like a connection problem rather than a lock problem.
    """

    @staticmethod
    async def _contend(connection: Any) -> None:
        """Acquire the connection's lock from two tasks at once, forcing a waiter future.

        The waiter is the whole point. ``asyncio.Lock`` binds to a loop when it creates one, and never
        otherwise, so this is the minimum work that makes the binding observable.

        Args:
            connection: The resolved connection whose lock to contend.
        """

        async def hold() -> None:
            async with connection.get_lock():
                await asyncio.sleep(0.01)

        await asyncio.gather(hold(), hold())

    def test_a_shared_config_works_across_two_successive_event_loops(self) -> None:
        """The requirement, asserted with two real ``asyncio.run`` calls as ``tasks.md`` specifies.

        ``asyncio.run`` creates a loop, runs, and closes it. Nothing short of that reproduces the
        failure: one loop with two tasks is the case that already works, and it is what a naive
        version of this test would do.
        """
        config: MongoDBConfig = {"database": "appdb", "connection_string": "mongodb://127.0.0.1:1/"}
        connection = _client.resolve(config)

        asyncio.run(self._contend(connection))
        asyncio.run(self._contend(connection))

    def test_the_same_config_resolved_again_in_the_new_loop_also_works(self) -> None:
        """The realistic shape: each invocation resolves the config for itself and hits the cache.

        The cache hit is what makes this interesting. A fresh resolution would return a fresh lock and
        never exercise the rebinding, so an implementation that rebinds nothing would pass. Sharing
        the entry across loops is exactly what ``REQ-E-012`` requires.
        """
        config: MongoDBConfig = {"database": "appdb", "connection_string": "mongodb://127.0.0.1:1/"}

        asyncio.run(self._contend(_client.resolve(config)))
        asyncio.run(self._contend(_client.resolve(config)))

    def test_the_lock_is_replaced_rather_than_reused_when_the_loop_changes(self) -> None:
        """The mechanism, because both tests above pass on a lock that is simply never contended.

        A ``get_lock()`` returning a brand-new lock every call would also pass them, and would
        serialize nothing. This pins the actual contract: same object within a loop, different object
        across loops.
        """
        config: MongoDBConfig = {"database": "appdb", "connection_string": "mongodb://127.0.0.1:1/"}
        connection = _client.resolve(config)

        async def bind_and_return() -> asyncio.Lock:
            await self._contend(connection)
            return connection.get_lock()

        first = asyncio.run(bind_and_return())
        second = asyncio.run(bind_and_return())

        assert first is not second

    def test_the_lock_is_stable_within_one_loop(self) -> None:
        """The other half of the contract, and the one that makes the lock a lock.

        Two coroutines on the same loop must receive the same object, or nothing is mutually excluded.
        """
        config: MongoDBConfig = {"database": "appdb", "connection_string": "mongodb://127.0.0.1:1/"}
        connection = _client.resolve(config)

        async def two_views() -> tuple[asyncio.Lock, asyncio.Lock]:
            return connection.get_lock(), connection.get_lock()

        first, second = asyncio.run(two_views())

        assert first is second
