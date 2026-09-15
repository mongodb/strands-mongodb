"""Tests for the test harness itself: does the tier gate actually gate?

``conftest.py``'s ``pytest_collection_modifyitems`` hook is the single mechanism keeping an
unconfigured backend from being reported as a pass. It has the property that makes untested
infrastructure dangerous, in both directions: break it open and every gated test skips while the
suite still reports green, and nobody investigates a green run; break it the other way and a missing
database looks like a broken test suite.

So the gate gets its own tests. ``pytester`` runs a nested pytest session with a synthetic test
file, which is the only way to observe skip behavior from the outside, since a test cannot watch
itself be skipped.

Covers the gating half of ``design-delta.md`` §5.1.
"""

from __future__ import annotations

import pytest

pytest_plugins = ["pytester"]

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
        monkeypatch.delenv(variable, raising=False)
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
        monkeypatch.delenv("MONGODB_URI", raising=False)
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
        monkeypatch.delenv("MONGODB_URI", raising=False)
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
            monkeypatch.delenv(variable, raising=False)
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
        monkeypatch.delenv("MONGODB_AUTOEMBED_URI", raising=False)
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
        monkeypatch.delenv("MONGODB_URI", raising=False)
        gated.makepyfile(
            """
            def test_forgot_the_marker(contract_uri):
                assert contract_uri
            """
        )

        result = gated.runpytest()

        result.assert_outcomes(errors=1, skipped=0, passed=0)
        result.stdout.fnmatch_lines(["*MONGODB_URI is unset*"])
