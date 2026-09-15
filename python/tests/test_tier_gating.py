"""Tests for the test harness itself: does the tier gate actually gate?

``conftest.py``'s ``pytest_collection_modifyitems`` hook is the single mechanism keeping an
unconfigured backend from being reported as a pass. It has the property that makes untested
infrastructure dangerous, in both directions: break it open and every gated test skips while the
suite still reports green, and nobody investigates a green run; break it the other way and a missing
database looks like a broken test suite.

So the gate gets its own tests. ``pytester`` runs a nested pytest session with a synthetic test
file, which is the only way to observe skip behavior from the outside, since a test cannot watch
itself be skipped.

Covers the gating half of ``design-delta.md`` §5.1, and §5.7's ``.env`` loader, which decides what the
gate sees in the first place.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from conftest import (
    ENV_FILE_LOCATIONS,
    TIER_VARIABLES,
    _require,
    fill_tier_variables_from_env,
    parse_env_file,
)

pytest_plugins = ["pytester"]

# How a test says "this machine has no backend for that tier". Deleting the variable stopped being
# enough once the real conftest learned to read `.env` (§5.7): every nested session re-imports that
# module, which re-fills any tier variable the file names and the environment lacks, so a `delenv` here
# was undone before the gate ran. An empty value is present, therefore never filled, and the gate reads
# it as unset because it tests truthiness. These tests are hermetic under both configurations now, where
# before they passed only on a checkout with no `.env` in it.
_NO_BACKEND = ""

# The nested session must exercise the real conftest, not a copy that could drift from it. It is
# loaded under a distinct module name because the nested file is itself named `conftest`, so a plain
# `from conftest import ...` resolves to the partially-initialized importer and fails circularly.
#
# Only the gating fixtures are re-exported. `_drop_test_databases` is deliberately left out: it is
# session-scoped autouse and would try to connect to whatever URI a test sets, blocking for the
# 30-second server-selection timeout against an address that need not exist.
_LOAD_REAL_CONFTEST = """
import importlib.util

_spec = importlib.util.spec_from_file_location("strands_mongodb_conftest_under_test", {conftest!r})
_real = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_real)

TIER_VARIABLES = _real.TIER_VARIABLES
pytest_collection_modifyitems = _real.pytest_collection_modifyitems
test_database_name = _real.test_database_name
contract_uri = _real.contract_uri
atlas_uri = _real.atlas_uri
autoembed_uri = _real.autoembed_uri
unique_collection_name = _real.unique_collection_name
"""


@pytest.fixture
def gated(pytester: pytest.Pytester, request: pytest.FixtureRequest) -> pytest.Pytester:
    """A nested pytest project that reuses this suite's real ``conftest.py``."""
    conftest = str(request.config.rootpath / "tests" / "conftest.py")
    pytester.makeconftest(_LOAD_REAL_CONFTEST.format(conftest=conftest))
    pytester.makeini(
        """
        [pytest]
        asyncio_default_fixture_loop_scope = function
        markers =
            contract: needs a real MongoDB deployment of any kind.
            integration: needs Atlas or an Atlas CLI local deployment with mongot.
            autoembed: needs a cluster with a registered Atlas embedding model.
        """
    )
    return pytester


class TestGateSkipsWhenUnconfigured:
    """A tier with no backend skips, and the reason names the variable to set."""

    @pytest.mark.parametrize(
        ("marker", "variable"),
        [
            ("contract", "MONGODB_URI"),
            ("integration", "MONGODB_ATLAS_URI"),
            ("autoembed", "MONGODB_AUTOEMBED_URI"),
        ],
    )
    def test_skips_naming_the_missing_variable(
        self,
        gated: pytest.Pytester,
        monkeypatch: pytest.MonkeyPatch,
        marker: str,
        variable: str,
    ) -> None:
        """The skip reason is actionable, not just present.

        ``pytest.skip("no database")`` would satisfy a "does it skip" test while telling the reader
        nothing. Asserting the variable name is in the reason is what makes the report useful.
        """
        monkeypatch.setenv(variable, _NO_BACKEND)
        gated.makepyfile(
            f"""
            import pytest

            @pytest.mark.{marker}
            def test_needs_a_backend():
                raise AssertionError("this body must never run")
            """
        )

        result = gated.runpytest("-rs")

        result.assert_outcomes(skipped=1, passed=0, failed=0)
        result.stdout.fnmatch_lines([f"*{variable}*"])

    def test_skips_rather_than_errors_when_the_test_requests_a_session_scoped_fixture(
        self, gated: pytest.Pytester, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Regression test for the fixture-ordering bug the harness smoke tests exposed.

        The gate was originally a function-scoped autouse fixture. Pytest instantiates
        higher-scoped fixtures first, so a test requesting the session-scoped ``contract_uri`` had it
        built — and raised — before the gate ran. The outcome was **errors**, not skips.

        That distinction is the whole point of the gate. An error says the suite is broken and
        someone should fix the tests; a skip says the environment lacks a backend and names the
        variable to set. Reporting the second as the first is how a team learns to ignore red.
        """
        monkeypatch.setenv("MONGODB_URI", _NO_BACKEND)
        gated.makepyfile(
            """
            import pytest

            @pytest.mark.contract
            def test_wants_a_database(contract_uri):
                raise AssertionError("this body must never run")
            """
        )

        result = gated.runpytest("-rs")

        result.assert_outcomes(skipped=1, errors=0, failed=0, passed=0)
        result.stdout.fnmatch_lines(["*MONGODB_URI*"])

    def test_class_level_marker_gates_every_method(
        self, gated: pytest.Pytester, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Markers applied to a class reach its methods.

        The harness smoke tests mark the class, not each method. If ``get_closest_marker`` did not
        walk up to the class, every one of them would run ungated.
        """
        monkeypatch.setenv("MONGODB_URI", _NO_BACKEND)
        gated.makepyfile(
            """
            import pytest

            @pytest.mark.contract
            class TestNeedsABackend:
                def test_one(self):
                    raise AssertionError("must never run")

                def test_two(self):
                    raise AssertionError("must never run")
            """
        )

        result = gated.runpytest()

        result.assert_outcomes(skipped=2, passed=0, errors=0)


class TestGateAllowsWhenConfigured:
    """A tier with its backend configured runs."""

    def test_runs_when_the_variable_is_set(self, gated: pytest.Pytester, monkeypatch: pytest.MonkeyPatch) -> None:
        """The complement of the skip test.

        Without this, a gate that skips unconditionally passes every skip assertion above. Both
        directions are needed or the gate is only half tested.
        """
        monkeypatch.setenv("MONGODB_URI", "mongodb://localhost:27017")
        gated.makepyfile(
            """
            import pytest

            @pytest.mark.contract
            def test_needs_a_backend():
                assert True
            """
        )

        result = gated.runpytest()

        result.assert_outcomes(passed=1, skipped=0, failed=0)

    def test_unmarked_test_always_runs(self, gated: pytest.Pytester, monkeypatch: pytest.MonkeyPatch) -> None:
        """The unit tier is ungated, so it runs with every backend variable absent."""
        for variable in ("MONGODB_URI", "MONGODB_ATLAS_URI", "MONGODB_AUTOEMBED_URI"):
            monkeypatch.setenv(variable, _NO_BACKEND)
        gated.makepyfile(
            """
            def test_pure_unit():
                assert True
            """
        )

        result = gated.runpytest()

        result.assert_outcomes(passed=1, skipped=0)


class TestMarkersAreRequirementsNotAlternatives:
    """Two markers mean two backends, not either one."""

    def test_a_test_with_two_markers_needs_both_variables(
        self, gated: pytest.Pytester, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """An ``autoembed`` test also carries ``integration``, and one variable must not satisfy both.

        The failure this prevents: setting only ``MONGODB_ATLAS_URI`` and having the AutoEmbeddings
        acceptance test run against a deployment with no registered model, where ``$vectorSearch``
        returns an empty result rather than an error (premortem **P-2**, observed live). It would
        report a pass.
        """
        monkeypatch.setenv("MONGODB_ATLAS_URI", "mongodb://localhost:27017")
        monkeypatch.setenv("MONGODB_AUTOEMBED_URI", _NO_BACKEND)
        gated.makepyfile(
            """
            import pytest

            @pytest.mark.integration
            @pytest.mark.autoembed
            def test_needs_both():
                raise AssertionError("this body must never run")
            """
        )

        result = gated.runpytest("-rs")

        result.assert_outcomes(skipped=1, passed=0)
        result.stdout.fnmatch_lines(["*MONGODB_AUTOEMBED_URI*"])


class TestFixtureMisuseFailsRatherThanSkips:
    """Requesting a backend fixture without the matching marker is a wiring bug."""

    def test_unmarked_test_requesting_a_gated_fixture_fails(
        self, gated: pytest.Pytester, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """It must fail loudly, not skip.

        A skip here would hide a test that intended to hit a real database and was silently never
        running. The distinction matters: a missing backend is the environment's fault and should
        skip, a missing marker is the test's fault and should fail.
        """
        monkeypatch.setenv("MONGODB_URI", _NO_BACKEND)
        gated.makepyfile(
            """
            def test_forgot_the_marker(contract_uri):
                assert contract_uri
            """
        )

        result = gated.runpytest()

        result.assert_outcomes(errors=1, skipped=0, passed=0)
        result.stdout.fnmatch_lines(["*MONGODB_URI is unset*"])


class TestTheEnvFileFillsTierVariables:
    """`design-delta.md` §5.7 — a URI written down in `.env` is configuration the harness should find.

    The gate above decides what happens when a variable is missing. This decides which variables exist,
    which is the earlier question and the one that silently skipped a whole suite: a cloud cluster sat in
    a `.env` file for a day while every tier reported "not configured".
    """

    def test_only_the_three_tier_variables_are_read(self, tmp_path: Path) -> None:
        """A `.env` is not an environment to import wholesale.

        The narrowing is the point. A file written for an application deployment can carry `PATH`, a
        cloud credential or a model key, and a harness that assimilates all of it changes how the
        interpreter resolves programs for the rest of the session.
        """
        env_file = tmp_path / ".env"
        env_file.write_text(
            "MONGODB_URI=mongodb://one\n"
            "MONGODB_ATLAS_URI=mongodb://two\n"
            "MONGODB_AUTOEMBED_URI=mongodb://three\n"
            "PATH=/nowhere\n"
            "AWS_SECRET_ACCESS_KEY=nope\n"
        )
        environ: dict[str, str] = {}

        filled = fill_tier_variables_from_env(environ, locations=[env_file])

        assert sorted(filled) == sorted(TIER_VARIABLES.values())
        assert environ == {
            "MONGODB_URI": "mongodb://one",
            "MONGODB_ATLAS_URI": "mongodb://two",
            "MONGODB_AUTOEMBED_URI": "mongodb://three",
        }

    def test_a_value_already_in_the_environment_is_never_replaced(self, tmp_path: Path) -> None:
        """The file fills gaps. CI exports its own URIs and must behave as if the file did not exist."""
        env_file = tmp_path / ".env"
        env_file.write_text("MONGODB_URI=mongodb://from-the-file\nMONGODB_ATLAS_URI=mongodb://also-the-file\n")
        environ = {"MONGODB_URI": "mongodb://from-the-shell"}

        filled = fill_tier_variables_from_env(environ, locations=[env_file])

        assert filled == ["MONGODB_ATLAS_URI"]
        assert environ["MONGODB_URI"] == "mongodb://from-the-shell"

    def test_an_explicitly_empty_value_means_no_backend_and_survives(self, tmp_path: Path) -> None:
        """`MONGODB_URI= pytest` is how a developer runs the unbacked tier deliberately.

        The gate reads an empty value as unset, so the two rules have to disagree about emptiness: the
        gate asks whether the value is truthy, and the loader asks whether the key is present. Were the
        loader to test truthiness too, opting out of a configured backend would be impossible from the
        command line, and `.env` would become mandatory rather than a default.
        """
        env_file = tmp_path / ".env"
        env_file.write_text("MONGODB_URI=mongodb://from-the-file\n")
        environ = {"MONGODB_URI": ""}

        filled = fill_tier_variables_from_env(environ, locations=[env_file])

        assert filled == []
        assert environ["MONGODB_URI"] == ""

    @pytest.mark.parametrize(
        ("line", "expected"),
        [
            ("MONGODB_URI=mongodb://host/?a=1&b=2", "mongodb://host/?a=1&b=2"),
            ('MONGODB_URI="mongodb://host/"', "mongodb://host/"),
            ("MONGODB_URI='mongodb://host/'", "mongodb://host/"),
            ("  MONGODB_URI = mongodb://host/  ", "mongodb://host/"),
            ("MONGODB_URI=mongodb://user:p%40ss@host/", "mongodb://user:p%40ss@host/"),
        ],
        ids=["equals-in-the-value", "double-quoted", "single-quoted", "padded", "escaped-password"],
    )
    def test_the_value_is_everything_after_the_first_equals(self, line: str, expected: str) -> None:
        """A connection string carries `=` in its query string, so splitting on every `=` truncates it.

        The escaped-password case is the one that would fail silently: a URI-encoded `@` or `:` is
        ordinary in a generated Atlas password, and a parser that unescapes or re-splits produces a
        string that connects to the wrong place or not at all.
        """
        assert parse_env_file(line) == {"MONGODB_URI": expected}

    def test_comments_blanks_and_malformed_lines_are_skipped(self) -> None:
        """A hand-edited file has commented-out URIs in it. None of them is a variable."""
        parsed = parse_env_file(
            "# the old cluster\n"
            "#MONGODB_URI=mongodb://retired\n"
            "\n"
            "   \n"
            "this line has no equals sign\n"
            "MONGODB_URI=mongodb://current\n"
        )

        assert parsed == {"MONGODB_URI": "mongodb://current"}

    def test_the_first_existing_location_wins(self, tmp_path: Path) -> None:
        """Two files are a mistake, not a merge. The nearer one is the one someone is editing."""
        first = tmp_path / "python" / ".env"
        first.parent.mkdir()
        first.write_text("MONGODB_URI=mongodb://nearer\n")
        second = tmp_path / ".env"
        second.write_text("MONGODB_URI=mongodb://further\nMONGODB_ATLAS_URI=mongodb://further-atlas\n")
        environ: dict[str, str] = {}

        fill_tier_variables_from_env(environ, locations=[first, second])

        assert environ == {"MONGODB_URI": "mongodb://nearer"}

    def test_no_file_anywhere_is_the_normal_case(self, tmp_path: Path) -> None:
        """CI has no `.env`. Absence is not a warning, an error, or a reason to skip differently."""
        environ: dict[str, str] = {}

        filled = fill_tier_variables_from_env(environ, locations=[tmp_path / "absent" / ".env"])

        assert filled == []
        assert environ == {}

    def test_the_locations_are_the_package_directory_then_the_repository_root(self) -> None:
        """Both are `.gitignore`d, and that is asserted rather than trusted.

        A harness that reads credentials from a path the repository would commit is a harness that
        teaches people to commit credentials. The file this feature was built for holds a live Atlas
        password.
        """
        package_directory = Path(__file__).resolve().parent.parent
        assert list(ENV_FILE_LOCATIONS) == [package_directory / ".env", package_directory.parent / ".env"]

        ignored = (package_directory.parent / ".gitignore").read_text().splitlines()
        assert ".env" in [line.strip() for line in ignored]

    def test_the_loader_ran_at_import_time(self) -> None:
        """Wiring, not parsing: the fixtures and the collection hook both read `os.environ`.

        Conditional because the file is `.gitignore`d and therefore absent on CI, which is the case the
        assertion has to tolerate rather than the case it is for.
        """
        present = [path for path in ENV_FILE_LOCATIONS if path.is_file()]
        if not present:
            pytest.skip("no .env in this checkout, which is the CI configuration")

        for name in parse_env_file(present[0].read_text()):
            if name in TIER_VARIABLES.values():
                assert name in os.environ, f"{name} is in {present[0]} but was never loaded"


class TestAFailureReportNeverCarriesThePassword:
    """AT-103 / REQ-E-103 — premortem **P-3**, on the harness side of the line `REQ-E-014` draws.

    `REQ-E-014` binds the package, and the package holds up: pymongo strips credentials from its own
    ``repr`` and nothing here formats a config. The value pytest prints is the one the harness read out
    of the environment before any package code ran, so no requirement on the package could have caught
    it. Measured in the all-tiers run of 2026-09-02, where six failures each printed the development
    cluster's user and password in full, from the fixture header alone.

    Two halves, because the mechanism and the outcome fail differently. The first asserts what the value
    does; the second runs a session that fails on purpose and reads the report, which is the artifact
    that actually reaches a CI log.
    """

    _SECRET = "Sup3rS3cret"
    _URI = f"mongodb+srv://alice:{_SECRET}@cluster0.example.mongodb.net/"

    def test_the_repr_redacts_while_the_value_still_connects(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """AT-103, the mechanism. Redacting ``str`` too would fail every connection instead."""
        monkeypatch.setenv("MONGODB_URI", self._URI)

        value = _require("MONGODB_URI")

        assert self._SECRET not in repr(value)
        assert self._SECRET not in f"{value!r}"
        assert "cluster0.example.mongodb.net" in repr(value), "the host is what makes a failure diagnosable"
        # The string still has to be the string. A wrapper that changed it would turn a disclosure bug
        # into a connection bug, which is worse: the first is visible in a log, the second in production.
        assert value == self._URI
        assert str(value) == self._URI

    def test_a_failing_test_does_not_print_the_password_in_its_fixture_header(
        self, gated: pytest.Pytester, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """AT-103, the outcome. The report is what reaches a CI log, so the report is what is asserted.

        The nested test both requests the fixture and fails, which is the shape the real run hit: pytest
        prints every fixture a failing test requested, using ``repr``.
        """
        monkeypatch.setenv("MONGODB_URI", self._URI)
        gated.makepyfile(
            """
            import pytest

            @pytest.mark.contract
            def test_fails_while_holding_the_uri(contract_uri):
                assert contract_uri
                assert False, "failing on purpose, to read what the report prints"
            """
        )

        result = gated.runpytest()

        result.assert_outcomes(failed=1)
        assert self._SECRET not in result.stdout.str(), "REQ-E-103: the password reached the report"
        result.stdout.fnmatch_lines(["*cluster0.example.mongodb.net*"])
