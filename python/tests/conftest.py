"""Shared fixtures and tier gating.

Four test tiers, distinguished by the infrastructure they need (plan §10.2). A tier whose backend
is absent **skips with the missing variable named**. It never silently passes, and it never fails
for lack of a database, because both of those teach the reader to ignore the result:

===============  =========================  ==============================================
Marker           Environment variable       Backend
===============  =========================  ==============================================
(none)           --                         none; mocked driver
``contract``     ``MONGODB_URI``            any real MongoDB, including a plain ``mongod``
``integration``  ``MONGODB_ATLAS_URI``      Atlas, or an Atlas CLI local deployment
``autoembed``    ``MONGODB_AUTOEMBED_URI``  a cluster with a registered embedding model
===============  =========================  ==============================================

``autoembed`` exists as a separate gate rather than as part of ``integration`` because an Atlas CLI
local deployment runs vector and full-text search but registers no embedding models, so
``$vectorSearch`` with ``autoEmbed`` cannot be exercised there. Folding it into ``integration``
would report the package's default search mode as covered when it was never run.
"""

from __future__ import annotations

import asyncio
import os
import subprocess
import sys
import textwrap
import uuid
from collections.abc import AsyncIterator, Callable, Iterator
from pathlib import Path
from typing import TYPE_CHECKING, Any

import pytest

if TYPE_CHECKING:
    from pymongo import AsyncMongoClient

# tests/ -> python/
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_SRC = _PROJECT_ROOT / "src"

# Marker -> the environment variable that supplies its backend. Order is widest-gate first so the
# skip message names the most permissive variable a test could be satisfied by.
TIER_VARIABLES: dict[str, str] = {
    "contract": "MONGODB_URI",
    "integration": "MONGODB_ATLAS_URI",
    "autoembed": "MONGODB_AUTOEMBED_URI",
}

# One database per test session, dropped on teardown. Concurrent sessions (a local run beside CI,
# or pytest-xdist workers) must not share a namespace, and a fixed name makes that collision
# invisible: the second session sees the first session's documents and passes for the wrong reason.
_SESSION_SUFFIX = uuid.uuid4().hex[:8]


def pytest_configure(config: pytest.Config) -> None:
    """Make the subprocess tests count toward coverage.

    Several tests assert on import-time behavior, which is only observable in a fresh interpreter,
    so they run their assertions in a child process. Nothing a child executes is measured unless
    ``coverage`` starts there too, and the ``.pth`` hook that starts it does nothing without
    ``COVERAGE_PROCESS_START``. pytest-cov 7.1 does not set that variable, so the parent sets it here
    for its children to inherit.

    Left unset, the missing-extra branches in ``storage.py`` and ``memory_store.py`` and the
    ``__dir__`` in ``__init__.py`` read as uncovered while being fully tested, and the per-module
    floor in ``scripts/check_module_coverage.py`` would fail on them. The likely response to that is
    an exemption entry, which would hide the real gap the floor exists to find.

    Only set when coverage is actually collecting. Otherwise a plain ``pytest`` run would leave
    ``.coverage.*`` data files behind from every subprocess it starts.

    Args:
        config: The active pytest configuration.
    """
    if getattr(config.option, "cov_source", None):
        os.environ["COVERAGE_PROCESS_START"] = str(_PROJECT_ROOT / "pyproject.toml")


def _run_mypy(
    source: str,
    tmp_path: Path,
    *,
    env: dict[str, str],
    cwd: Path,
    extra_args: tuple[str, ...] = (),
) -> subprocess.CompletedProcess[str]:
    """Write a snippet to ``tmp_path`` and type check it in a subprocess.

    Args:
        source: Python source. Dedented, so a triple-quoted snippet can stay indented at its call
            site.
        tmp_path: Directory to hold the snippet and mypy's cache.
        env: Full environment for the subprocess.
        cwd: Working directory, which determines the config file mypy discovers.
        extra_args: Additional mypy arguments, appended before the snippet path.

    Returns:
        The completed process, with mypy's notes and errors on ``stdout``.
    """
    snippet = tmp_path / "snippet.py"
    snippet.write_text(textwrap.dedent(source))
    return subprocess.run(
        [sys.executable, "-m", "mypy", "--no-incremental", f"--cache-dir={tmp_path / '.mypy_cache'}"]
        + list(extra_args)
        + [str(snippet)],
        capture_output=True,
        text=True,
        env=env,
        cwd=cwd,
        check=False,
    )


@pytest.fixture
def run_mypy(tmp_path: Path) -> Callable[[str], subprocess.CompletedProcess[str]]:
    """Type check a source snippet against this working tree.

    Several requirements are promises to a type checker rather than to the interpreter: a
    ``Required`` key, a narrow ``Literal``, the class a lazily exported name resolves to. None of
    them can be asserted at runtime, and a requirement no test can observe is a comment. This runs
    the checker the project ships with and lets the test read its output.

    ``MYPYPATH`` names ``src`` rather than relying on the editable install, so the result describes
    the code in this tree and not whichever build the venv last resolved. The subprocess runs in the
    project root, so mypy finds ``[tool.mypy]`` in ``pyproject.toml`` and checks at the declared 3.10
    floor. An explicit file argument overrides the ``files`` list there.

    Use :func:`run_mypy_as_installed` instead for anything a **consumer** of the built package would
    see. Putting ``src`` on the path is what lets mypy analyze this package at all, so this fixture
    cannot observe whether the distribution advertises its types.

    Returns:
        A callable taking Python source and returning the completed mypy process, with its notes and
        errors on ``stdout``.
    """

    def run(source: str) -> subprocess.CompletedProcess[str]:
        return _run_mypy(
            source,
            tmp_path,
            env={**os.environ, "MYPYPATH": str(_SRC)},
            cwd=_PROJECT_ROOT,
        )

    return run


@pytest.fixture
def run_mypy_as_installed(tmp_path: Path) -> Callable[[str], subprocess.CompletedProcess[str]]:
    """Type check a snippet the way a consumer's own project would.

    Three differences from :func:`run_mypy`, and each one removes a way this repository flatters
    itself:

    * No ``MYPYPATH``. The package has to be found through the install, as a dependency, not as a
      directory of source files that happens to be on the path.
    * A generated config rather than ours, with ``ignore_missing_imports`` off. Our own setting is
      ``true``, which is right for third-party libraries without stubs and wrong here: it turns "I
      could not read this package's types" into silence, and every symbol from it into ``Any``.
    * ``tmp_path`` as the working directory, so no config or source tree of ours is discovered by
      proximity.

    That combination is what makes the PEP 561 marker observable. Without ``py.typed`` mypy finds the
    package, declines to read it, and reports ``module is installed, but missing library stubs or
    py.typed marker``.

    Returns:
        A callable taking Python source and returning the completed mypy process.
    """
    config = tmp_path / "mypy.ini"
    config.write_text("[mypy]\npython_version = 3.10\nignore_missing_imports = false\n")
    env = {key: value for key, value in os.environ.items() if key != "MYPYPATH"}

    def run(source: str) -> subprocess.CompletedProcess[str]:
        return _run_mypy(
            source,
            tmp_path,
            env=env,
            cwd=tmp_path,
            extra_args=("--config-file", str(config)),
        )

    return run


@pytest.fixture(scope="session")
def test_database_name() -> str:
    """Name of this session's throwaway database.

    Returns:
        A name unique to this session, of the form ``strands_mongodb_test_<8 hex chars>``.
    """
    return f"strands_mongodb_test_{_SESSION_SUFFIX}"


def pytest_collection_modifyitems(items: list[pytest.Item]) -> None:
    """Mark every test whose tier has no configured backend as skipped, naming the variable.

    A collection hook rather than an autouse fixture, and the difference is not stylistic. An
    autouse function-scoped fixture runs *after* any session-scoped fixture the test requests, so
    ``contract_uri`` would be instantiated first and raise before the gate ever ran. The observable
    result was an **error**, not a skip: a missing backend reported as a broken suite. Found by
    running the harness smoke tests with no ``MONGODB_URI`` set.

    Collection-time gating has no such ordering problem, because nothing has been set up yet.

    A test carrying two tier markers needs both variables. Markers describe requirements, not
    alternatives.
    """
    for item in items:
        for marker, variable in TIER_VARIABLES.items():
            if item.get_closest_marker(marker) is None:
                continue
            if not os.environ.get(variable):
                item.add_marker(
                    pytest.mark.skip(
                        reason=f"{marker} tier needs {variable} to be set to a deployment this test may write to"
                    )
                )
                break


def _require(variable: str) -> str:
    """Read a gate variable that ``_tier_gate`` has already proven present.

    Args:
        variable: Name of the environment variable to read.

    Returns:
        The variable's value.

    Raises:
        RuntimeError: If the variable is unset, which means a fixture was requested by a test
            carrying no matching tier marker. That is a wiring bug in the test, not a missing
            backend, so it must fail rather than skip.
    """
    value = os.environ.get(variable)
    if not value:
        raise RuntimeError(
            f"{variable} is unset but a fixture requiring it was requested. Add the matching tier "
            f"marker to the test so it is gated instead of failing here."
        )
    return value


@pytest.fixture(scope="session")
def contract_uri() -> str:
    """Connection string for a real MongoDB deployment of any kind."""
    return _require("MONGODB_URI")


@pytest.fixture(scope="session")
def atlas_uri() -> str:
    """Connection string for a deployment with Atlas Search available."""
    return _require("MONGODB_ATLAS_URI")


@pytest.fixture(scope="session")
def autoembed_uri() -> str:
    """Connection string for a cluster with a registered Atlas embedding model."""
    return _require("MONGODB_AUTOEMBED_URI")


async def _drop_database(uri: str, database: str) -> None:
    """Drop a database, including any search indexes on its collections.

    Args:
        uri: Connection string for the deployment holding the database.
        database: Name of the database to drop.
    """
    from pymongo import AsyncMongoClient

    client: AsyncMongoClient[Any] = AsyncMongoClient(uri)
    try:
        db = client[database]
        for name in await db.list_collection_names():
            # A dropped collection can leave a search index building on mongot, which then holds a
            # name we may want to reuse. Drop the indexes by name first, and tolerate a deployment
            # with no search support, where list_search_indexes is not available at all.
            try:
                async for index in await db[name].list_search_indexes():
                    await db[name].drop_search_index(index["name"])
            except Exception:  # noqa: BLE001 - teardown must not mask the test's own result
                pass
        await client.drop_database(database)
    finally:
        await client.close()


@pytest.fixture(scope="session", autouse=True)
def _drop_test_databases(test_database_name: str) -> Iterator[None]:
    """Drop this session's database from every configured deployment, on the way out.

    Session-scoped and synchronous on purpose. It runs ``asyncio.run`` in a fresh loop rather than
    holding a client across the session, because sharing one client across every test's loop is the
    exact pattern ``REQ-E-017`` exists to handle. The harness must not depend on the behavior under
    test.
    """
    yield
    for variable in ("MONGODB_URI", "MONGODB_ATLAS_URI", "MONGODB_AUTOEMBED_URI"):
        uri = os.environ.get(variable)
        if not uri:
            continue
        try:
            asyncio.run(_drop_database(uri, test_database_name))
        except Exception as error:  # noqa: BLE001 - report, never fail the session on cleanup
            print(f"warning: could not drop {test_database_name} on {variable}: {error!r}")


@pytest.fixture
async def contract_database(contract_uri: str, test_database_name: str) -> AsyncIterator[Any]:
    """An ``AsyncDatabase`` on a real deployment, with a per-test client.

    A fresh client per test keeps each test on its own event loop and makes cross-test pollution
    through a shared pool impossible.
    """
    from pymongo import AsyncMongoClient

    client: AsyncMongoClient[Any] = AsyncMongoClient(contract_uri)
    try:
        yield client[test_database_name]
    finally:
        await client.close()


@pytest.fixture
async def atlas_database(atlas_uri: str, test_database_name: str) -> AsyncIterator[Any]:
    """An ``AsyncDatabase`` on a deployment with Atlas Search available."""
    from pymongo import AsyncMongoClient

    client: AsyncMongoClient[Any] = AsyncMongoClient(atlas_uri)
    try:
        yield client[test_database_name]
    finally:
        await client.close()


@pytest.fixture
def unique_collection_name(request: pytest.FixtureRequest) -> str:
    """A collection name unique to the requesting test.

    Derived from the test's own name so a failure points at its data, with a random suffix so a
    reran test never inherits residue from the run before it.

    Returns:
        A collection name safe to create and drop.
    """
    stem = request.node.name.replace("[", "_").replace("]", "").replace("-", "_")
    return f"{stem}_{uuid.uuid4().hex[:6]}"[:100]
