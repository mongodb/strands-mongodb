"""The two shipped examples, run as subprocesses rather than read as documentation.

The tests are split across three tiers, because the two scripts need different deployments and three
of the classes need none:

=========================================  ==========================  ===================================
Class                                      Tier                        Why
=========================================  ==========================  ===================================
``TestTheMemoryExampleAcrossTwoProcesses``   ``example`` + ``autoembed``  recalls a fact from a query sharing
                                                                         no word with it, which only
                                                                         server-side embeddings can answer
``TestTheStorageExampleAcrossTwoProcesses``  ``example`` + ``contract``   ``Storage`` is primary-key reads
                                                                         and a key-space scan; no search
                                                                         index exists
``TestTheScriptedModelStream``,              unit                        a stream mapping, a refusal to
``TestTheScriptsRefuseToStartAndSayWhy``,                                start, and four lines of
``TestTheExamplesAreInsideEveryFileSet``                                 ``pyproject.toml``
=========================================  ==========================  ===================================

**``example`` is a selector, not a gate.** It has no environment variable of its own, the way ``compat``
and ``gate`` do not, so ``-m example`` collects both subprocess tests and the tier marker beside it decides
whether either runs. A test carrying only ``example`` would run everywhere and need a deployment nowhere,
which is the failure this arrangement avoids.

**Nothing here imports ``examples/``.** The scripts are run with ``sys.executable`` and read through
their exit status and their stdout, which is what the reader does. ``TestTheScriptedModelStream`` needs to
see the events ``ScriptedModel`` yields, so it imports ``_support`` inside a child interpreter with
``examples/`` on the path, and the parent process never does. Keeping the package's own test suite free of
an import path into ``examples/`` stops a script from becoming a library that only the tests depend on.

**The two subprocess tests cross a process boundary.** What passes from the first process to the second
is whatever MongoDB holds and the command line the first process printed. A second ``Agent`` in one
interpreter would exercise neither, while looking like a restart in the test's name.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any

import pytest

if sys.version_info >= (3, 11):
    import tomllib
else:  # pragma: no cover - exercised only on the 3.10 floor
    # `tomli` is the parser `tomllib` was adopted from, and 2.x is the API `tomllib` shipped, so the
    # alias makes the two interchangeable and every caller below reads one name. It is a dev dependency
    # declared without a version marker on purpose; `pyproject.toml` says why, and the reason is mypy
    # rather than this branch.
    import tomli as tomllib

# tests/ -> python/
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_EXAMPLES = _PROJECT_ROOT / "examples"
_PYPROJECT = _PROJECT_ROOT / "pyproject.toml"

# Any URI carrying credentials, in either scheme. Matched against everything both scripts print, on
# every path, because a redaction that holds for the happy path and not for the error path leaks a
# live Atlas password into a CI log exactly when someone is reading it.
#
# The lookahead is the one thing this pattern permits, and it is permitted exactly: `_support.redact`
# replaces the whole userinfo with `<redacted>`, so `mongodb+srv://<redacted>@host` is the redaction
# working rather than a leak, and without the lookahead the guard would flag the redacted output. A
# partial redaction such as `user:<redacted>@` does not start with the placeholder and is still caught.
#
# `\S*`, not `[^\s/]*`: a password pasted without percent-encoding can hold a `/`, and a pattern that
# stops at the first one does not see that URI at all.
_CREDENTIALED_URI = re.compile(r"mongodb(\+srv)?://(?!<redacted>@)\S*@")

# Punctuation the no-shared-word check strips before comparing, so `"dark-mode."` and `"dark mode"`
# are not counted as different words. The memory example makes this check itself; the two-process test
# repeats it over what the script printed, which is the only way to catch a script whose own check
# passes against literals it no longer uses.
_NOT_A_WORD = re.compile(r"[^a-z0-9]+")

# How long the memory example's two-process test waits for a written memory to become searchable, and
# how long it pauses between tries.
#
# Atlas embeds a newly inserted document after the write acknowledges. There is no status field for it
# anywhere in the driver surface, unlike the index build that `_indexes.ensure` polls, so waiting is
# the only thing a caller can do. On a quiet cluster `add()` returns in well under a second and the
# document answers a vector query about 15 s later. The budget is 90 s, roughly six times that, because
# that figure is one cluster's behaviour under no load and not a guarantee.
#
# The deadline keeps the test deterministic, and it is why the assertion below fires when the deadline
# expires: a regression that stops writing altogether never produces a hit, so it still fails, after
# the full 90 seconds.
_EMBEDDING_BUDGET_SECONDS = 90.0
_EMBEDDING_POLL_SECONDS = 5.0


def _words(text: str) -> set[str]:
    """Return the distinct lowercase words in ``text``.

    Args:
        text: Any prose.

    Returns:
        Word set, empty strings dropped.
    """
    return {word for word in _NOT_A_WORD.split(text.lower()) if word}


def _run(script: str, *arguments: str, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    """Run one shipped example as a child process and capture both streams.

    ``check=False`` throughout. Every test here asserts on the exit status, including the two that
    require a non-zero one, and ``check=True`` would turn a deliberate refusal into an error before
    the assertion could read it.

    Args:
        script: File name inside ``examples/``.
        arguments: Command-line arguments, step name first.
        env: Full environment for the child.

    Returns:
        The completed process, with the script's prose on ``stdout``.
    """
    return subprocess.run(
        [sys.executable, str(_EXAMPLES / script), *arguments],
        capture_output=True,
        text=True,
        env=env,
        cwd=_PROJECT_ROOT,
        check=False,
    )


def _both_streams(result: subprocess.CompletedProcess[str]) -> str:
    """Return stdout and stderr joined, for assertions about what a script did or did not print."""
    return f"{result.stdout}\n{result.stderr}"


def _summary(result: subprocess.CompletedProcess[str]) -> dict[str, Any]:
    """Parse the final ``--summary-json`` line.

    Args:
        result: A completed run made with ``--summary-json``.

    Returns:
        The decoded object.

    Raises:
        AssertionError: If the last line of stdout is not a JSON object, which means the flag printed
            nothing and every assertion downstream would be reading a stale run.
    """
    lines = [line for line in result.stdout.splitlines() if line.strip()]
    assert lines, f"the script printed nothing on stdout\n{_both_streams(result)}"
    try:
        summary = json.loads(lines[-1])
    except json.JSONDecodeError as error:
        raise AssertionError(f"the last stdout line is not JSON ({error})\n{_both_streams(result)}") from error
    assert isinstance(summary, dict), f"the summary line is not an object: {summary!r}"
    return summary


def _no_credentials(result: subprocess.CompletedProcess[str], uri: str | None = None) -> None:
    """Assert neither stream carries a connection string or the password inside one.

    Args:
        result: A completed run.
        uri: The connection string the run was given, when it was given one. Its password is checked
            for separately, because a script could print the secret without the surrounding URI and
            the pattern alone would not see it.
    """
    output = _both_streams(result)
    assert not _CREDENTIALED_URI.search(output), f"a credentialed URI reached the output\n{output}"
    if uri:
        password = re.search(r"://[^:@/]+:(.+)@", uri)
        if password:
            assert password.group(1) not in output, "the URI password reached the output"


def _recall_until_embedded(
    arguments: tuple[str, ...],
    environment: dict[str, str],
    uri: str,
    stored: list[str],
) -> tuple[subprocess.CompletedProcess[str], dict[str, Any], list[dict[str, Any]]]:
    """Run the recall step until it returns a hit matching something the write step stored.

    Polls on ``recalled`` rather than on any hit, which matters: the curated store's fact is written
    first and becomes searchable first, so a run can report one hit while the fact under test is still
    unembedded. Waiting on any hit would pass with the extracted memory missing.

    Every attempt is a full subprocess, because crossing the process boundary is what the test proves.
    Each one also gets the credential sweep, because a leak on a later attempt is still a leak.

    Args:
        arguments: The shared command line, identical to the write step's.
        environment: Environment for the child, carrying the AutoEmbeddings URI.
        uri: The same URI, for the credential check.
        stored: Contents the write step reported storing.

    Returns:
        The successful run, its parsed summary, and the hits matching ``stored``.

    Raises:
        AssertionError: If the budget expires, or if any attempt exits non-zero or leaks a credential.
    """
    deadline = time.monotonic() + _EMBEDDING_BUDGET_SECONDS
    attempts = 0
    while True:
        recall = _run("memory_recall.py", "recall", *arguments, env=environment)
        attempts += 1
        assert recall.returncode == 0, _both_streams(recall)
        _no_credentials(recall, uri)
        found = _summary(recall)
        recalled = [hit for hit in found["hits"] if hit["content"] in stored]
        if recalled:
            return recall, found, recalled
        if time.monotonic() >= deadline:
            raise AssertionError(
                f"no hit matched anything the write step stored after {attempts} attempt(s) over "
                f"{_EMBEDDING_BUDGET_SECONDS:.0f}s. Expected one of {stored!r}.\n{_both_streams(recall)}"
            )
        time.sleep(_EMBEDDING_POLL_SECONDS)


def _unconfigured_environment() -> dict[str, str]:
    """Return an environment with every tier variable emptied.

    ``conftest.py`` fills the three tier variables from ``.env`` at import time, so a child that
    inherited this process's environment unchanged would find a live cluster and the refusal under
    test would never happen. Empty rather than absent, matching how a run opts out of a configured
    deployment everywhere else in this suite.
    """
    return {**os.environ, "MONGODB_URI": "", "MONGODB_ATLAS_URI": "", "MONGODB_AUTOEMBED_URI": ""}


@pytest.mark.example
@pytest.mark.autoembed
class TestTheMemoryExampleAcrossTwoProcesses:
    """AT-086. A fact written by one process is recalled by another.

    One test, because the claim is one claim: a fact written by a process that has exited is found by a
    process that never saw it, using a query with no word in common with it. Splitting it into "the write
    step exits zero" and "the recall step finds something" would let the second pass on residue from an
    earlier run, which is why both steps take the temporary collection ``conftest.py`` drops on teardown
    and a scope unique to this test.

    The tier is ``autoembed`` rather than ``integration``. A query
    sharing no token with the stored fact is answerable only by a vector search whose embeddings the
    server produced; on a deployment with mongot and no registered model there is nothing to embed the
    query with, and the test would fail for the configuration rather than for the code.
    """

    def test_the_second_process_recalls_what_the_first_process_wrote(
        self,
        autoembed_uri: str,
        test_database_name: str,
        unique_collection_name: str,
    ) -> None:
        """Two subprocesses, one collection, and a hit from the writable store on a disjoint query."""
        environment = {**os.environ, "MONGODB_URI": autoembed_uri}
        scope = f"at086-{uuid.uuid4().hex[:8]}"
        arguments = (
            "--database",
            test_database_name,
            "--collection",
            unique_collection_name,
            "--scope",
            scope,
            "--summary-json",
        )

        write = _run("memory_recall.py", "write", *arguments, env=environment)
        assert write.returncode == 0, _both_streams(write)
        _no_credentials(write, autoembed_uri)
        written = _summary(write)

        # The printed handoff to the recall step, checked here against a command that has to work rather
        # than only against the `--dry-run` text `TestTheScriptsRefuseToStartAndSayWhy` reads.
        assert "recall" in write.stdout
        assert scope in write.stdout

        stored = [entry["content"] for entry in written["stored"]]
        assert stored, f"the write step reported no stored entries: {written!r}"

        # Retried, not run once. The write above has acknowledged and the document is durable, but Atlas
        # embeds it afterwards and a search before that finishes returns nothing rather than failing, so a
        # single attempt would fail with the code working as specified.
        recall, found, recalled = _recall_until_embedded(arguments, environment, autoembed_uri, stored)
        hits = found["hits"]

        # The fact itself, in the prose the reader sees, not only in the machine-readable line.
        assert recalled[0]["content"] in recall.stdout
        assert isinstance(recalled[0]["score"], float)

        # Two stores in one manager, and the hit comes from the writable one by name.
        assert any(hit["store_name"] == found["writable_store"] for hit in recalled), (
            f"no hit came from the writable store {found['writable_store']!r}: {hits!r}"
        )

        # No shared word, re-derived from the two strings the script printed. A script that checks its
        # own literals and then queries with something else would pass its own check and fail here.
        overlap = _words(found["query"]) & _words(recalled[0]["content"])
        assert not overlap, f"query and fact share {sorted(overlap)}"


@pytest.mark.example
@pytest.mark.contract
class TestTheStorageExampleAcrossTwoProcesses:
    """AT-089. One collection serves three SDK subsystems, across two processes.

    ``contract`` and not ``integration``: everything this example does is a primary-key write, a
    primary-key read and a bounded ``_id`` range scan, so it runs against a plain ``mongod``. The
    prefix census is a ``list()`` over key space, which needs no search index and no mongot.

    The three prefixes are read with a direct client rather than from the script's own census, and the
    difference matters. The script prints what it reads, so a census assertion made against that output
    would confirm the script agrees with itself. The test proves that three SDK subsystems landed in one
    collection, which only an independent reader can confirm.
    """

    async def test_one_collection_serves_three_subsystems_and_the_session_survives_a_restart(
        self,
        contract_uri: str,
        contract_database: Any,
        test_database_name: str,
        unique_collection_name: str,
    ) -> None:
        """Three key prefixes after ``run``, and a restored message count after ``resume``."""
        environment = {**os.environ, "MONGODB_URI": contract_uri}
        session_id = f"at089-{uuid.uuid4().hex[:8]}"
        arguments = (
            "--database",
            test_database_name,
            "--collection",
            unique_collection_name,
            "--session-id",
            session_id,
            "--summary-json",
        )

        first = _run("unified_storage.py", "run", *arguments, env=environment)
        assert first.returncode == 0, _both_streams(first)
        _no_credentials(first, contract_uri)

        keys = [
            str(document["_id"]) async for document in contract_database[unique_collection_name].find({}, {"_id": 1})
        ]
        for prefix in ("session/", "context/", "memory/"):
            assert any(key.startswith(prefix) for key in keys), f"nothing under {prefix!r}: {sorted(keys)}"

        second = _run("unified_storage.py", "resume", *arguments, env=environment)
        assert second.returncode == 0, _both_streams(second)
        _no_credentials(second, contract_uri)
        resumed = _summary(second)

        assert resumed["restored_messages"] > 0, f"nothing was restored\n{_both_streams(second)}"

        # The storage-versus-memory sentence, found by its one technical term so the assertion does not pin
        # the rest of the wording. It has to name both halves of the distinction to be the sentence at all.
        cited = [line for line in second.stdout.splitlines() if "token overlap" in line]
        assert cited, f"the storage-versus-memory-collection sentence is missing\n{second.stdout}"
        assert any("storage" in line.lower() and "memor" in line.lower() for line in cited), cited


# Run in a child interpreter with `examples/` on `PYTHONPATH`, so the parent test process never
# imports the example support module. `ScriptedModel` is scripted with one text reply and one toolUse
# reply, which is the smallest pair that shows the stop reason changing.
_SCRIPTED_MODEL_EVENTS = """
import asyncio
import json

from _support import ScriptedModel


async def main():
    model = ScriptedModel(
        [
            {"role": "assistant", "content": [{"text": "the coffee order is a flat white"}]},
            {
                "role": "assistant",
                "content": [
                    {"toolUse": {"name": "remember", "toolUseId": "tooluse-1", "input": {"note": "flat white"}}}
                ],
            },
        ]
    )
    prompt = [{"role": "user", "content": [{"text": "hello"}]}]
    # Two explicit passes rather than a comprehension around the async one: nesting an `async for`
    # comprehension inside a plain comprehension is a SyntaxError on 3.10, the floor `requires-python`
    # declares, and legal only from 3.11. Nothing lints this string, so `AT-110` parses it instead.
    streams = []
    for _ in range(2):
        streams.append([event async for event in model.stream(prompt)])
    try:
        [event async for event in model.stream(prompt)]
    except Exception as error:
        exhausted = type(error).__name__
    else:
        exhausted = None
    print(json.dumps({"streams": streams, "exhausted": exhausted}))


asyncio.run(main())
"""

_TEXT_BLOCK_EVENTS = [
    {"messageStart": {"role": "assistant"}},
    {"contentBlockStart": {"start": {}}},
    {"contentBlockDelta": {"delta": {"text": "the coffee order is a flat white"}}},
    {"contentBlockStop": {}},
    {"messageStop": {"stopReason": "end_turn"}},
]

_TOOL_USE_BLOCK_EVENTS = [
    {"messageStart": {"role": "assistant"}},
    {"contentBlockStart": {"start": {"toolUse": {"name": "remember", "toolUseId": "tooluse-1"}}}},
    {"contentBlockDelta": {"delta": {"toolUse": {"input": '{"note": "flat white"}'}}}},
    {"contentBlockStop": {}},
    {"messageStop": {"stopReason": "tool_use"}},
]


class TestTheScriptedModelStream:
    """AT-087. The bundled model emits the sequence the event loop reads.

    Whole-list equality rather than a set of spot checks, and that is the point of the test. A stream
    missing its ``messageStop``, or carrying a ``contentBlockDelta`` with no ``contentBlockStart`` before
    it, does not raise: the event loop waits for a block that never opens or closes, and the example
    hangs with no output. A hang is the worst failure to debug in a script whose whole job is to be run
    once by someone unfamiliar with it, so the shape is pinned exactly.

    The expected lists were derived from the SDK's own ``tests/fixtures/mocked_model_provider.py``,
    whose ``map_agent_message_to_events`` is the sequence every provider is written against.
    """

    def test_the_two_reply_shapes_map_to_the_documented_event_sequences(self) -> None:
        """One text block, one toolUse block, and the stop reason that goes with each."""
        result = subprocess.run(
            [sys.executable, "-c", _SCRIPTED_MODEL_EVENTS],
            capture_output=True,
            text=True,
            env={**os.environ, "PYTHONPATH": str(_EXAMPLES)},
            cwd=_PROJECT_ROOT,
            check=False,
        )
        assert result.returncode == 0, _both_streams(result)

        payload = json.loads(result.stdout.splitlines()[-1])
        assert payload["streams"][0] == _TEXT_BLOCK_EVENTS
        assert payload["streams"][1] == _TOOL_USE_BLOCK_EVENTS
        assert payload["exhausted"] == "RuntimeError"


# Run in a child interpreter for the reason `_SCRIPTED_MODEL_EVENTS` is: the parent never imports `examples/`.
_REDACT_EACH_ARGUMENT = """
import json
import sys

from _support import redact

print(json.dumps([redact(uri) for uri in sys.argv[1:]]))
"""

# A password is percent-encoded in a valid URI, so `/` and `@` inside one mean it was pasted raw. That is
# the URI the driver rejects, and the scripts print the redacted form before the driver sees it.
_REDACTIONS = [
    (
        "mongodb+srv://appuser:s3cret@cluster.example.mongodb.net/?appName=demo",
        "mongodb+srv://<redacted>@cluster.example.mongodb.net/?appName=demo",
    ),
    (
        "mongodb+srv://appuser:pa/ss@cluster.example.mongodb.net/",
        "mongodb+srv://<redacted>@cluster.example.mongodb.net/",
    ),
    ("mongodb://appuser:p@ss@127.0.0.1:27017/", "mongodb://<redacted>@127.0.0.1:27017/"),
    ("mongodb://127.0.0.1:27017/?directConnection=true", "mongodb://127.0.0.1:27017/?directConnection=true"),
]

_FIRST_STEPS = [
    pytest.param("memory_recall.py", "write", "recall", "--scope", id="memory_recall"),
    pytest.param("unified_storage.py", "run", "resume", "--session-id", id="unified_storage"),
]


class TestTheScriptsRefuseToStartAndSayWhy:
    """AT-088. The unit-tier half of the examples.

    Three properties, none of which needs a deployment, and all three of which are what a reader meets
    first: the script refuses to start when it has no cluster and names the variable it wants, it will
    describe a step without connecting, and it stays quiet on stdout unless asked for a machine-readable
    line.

    ``--dry-run`` is why the printed handoff to the second step is checkable here at all. The alternative
    is asserting it only inside the two subprocess test classes, which leaves the one string joining the
    two processes unchecked in every run with no ``MONGODB_URI``, which is most local runs.
    """

    @pytest.mark.parametrize(("script", "first", "second", "carried"), _FIRST_STEPS)
    def test_an_unconfigured_run_exits_non_zero_naming_the_variable(
        self, script: str, first: str, second: str, carried: str
    ) -> None:
        """No ``MONGODB_URI``, no connection attempt, and the variable named in the message."""
        result = _run(script, first, env=_unconfigured_environment())

        assert result.returncode != 0, _both_streams(result)
        assert "MONGODB_URI" in _both_streams(result)
        _no_credentials(result)

    @pytest.mark.parametrize(("script", "first", "second", "carried"), _FIRST_STEPS)
    def test_a_dry_run_needs_no_cluster_and_prints_the_next_command(
        self, script: str, first: str, second: str, carried: str
    ) -> None:
        """The printed handoff names the second step and carries the options this run was given."""
        result = _run(script, first, "--dry-run", carried, "at088", env=_unconfigured_environment())

        assert result.returncode == 0, _both_streams(result)
        _no_credentials(result)

        handoff = [line for line in result.stdout.splitlines() if script in line and second in line]
        assert handoff, f"no line names {script} and the {second!r} step\n{result.stdout}"
        # The options this run was given have to survive into the printed command. A handoff that
        # silently drops `--scope` sends the reader to a namespace the first step never wrote to.
        assert any(f"{carried} at088" in line for line in handoff), handoff

    @pytest.mark.parametrize(("script", "first", "second", "carried"), _FIRST_STEPS)
    def test_only_the_summary_flag_puts_json_on_stdout(
        self, script: str, first: str, second: str, carried: str
    ) -> None:
        """Prose by default, one JSON object as the last line with the flag."""
        environment = _unconfigured_environment()

        quiet = _run(script, first, "--dry-run", env=environment)
        assert quiet.returncode == 0, _both_streams(quiet)
        for line in quiet.stdout.splitlines():
            with pytest.raises(json.JSONDecodeError):
                json.loads(line)

        loud = _run(script, first, "--dry-run", "--summary-json", env=environment)
        assert loud.returncode == 0, _both_streams(loud)
        assert _summary(loud)["step"] == first

    def test_redact_replaces_everything_up_to_the_last_at_sign(self) -> None:
        """A password holding an unencoded ``/`` or ``@`` is replaced whole, and a URI without one is left alone."""
        result = subprocess.run(
            [sys.executable, "-c", _REDACT_EACH_ARGUMENT, *(uri for uri, _ in _REDACTIONS)],
            capture_output=True,
            text=True,
            env={**os.environ, "PYTHONPATH": str(_EXAMPLES)},
            cwd=_PROJECT_ROOT,
            check=False,
        )
        assert result.returncode == 0, _both_streams(result)

        redacted = json.loads(result.stdout)
        assert redacted == [expected for _, expected in _REDACTIONS]
        assert not any(_CREDENTIALED_URI.search(line) for line in redacted)

    @pytest.mark.parametrize(
        ("line", "is_a_leak"),
        [
            ("connecting to mongodb+srv://<redacted>@cluster.example.mongodb.net/", False),
            ("connecting to mongodb://<redacted>@127.0.0.1:27017/", False),
            ("connecting to mongodb+srv://appuser:s3cret@cluster.example.mongodb.net/", True),
            ("connecting to mongodb+srv://appuser:<redacted>@cluster.example.mongodb.net/", True),
            ("connecting to mongodb+srv://<redacted>:pw@cluster.example.mongodb.net/", True),
            ("connecting to mongodb+srv://appuser:pa/ss@cluster.example.mongodb.net/", True),
            ("connecting to mongodb://appuser:p@ss@127.0.0.1:27017/", True),
            ("connecting to mongodb+srv://cluster.example.mongodb.net/", False),
        ],
    )
    def test_the_credential_guard_permits_only_the_exact_redaction(self, line: str, is_a_leak: bool) -> None:
        """The guard itself, because it is the only thing between an Atlas password and a CI log.

        A test of a test. The pattern allows exactly one thing in the userinfo position, the
        ``<redacted>`` placeholder that ``_support.redact`` writes. A loosely written lookahead would allow
        everything, so the two partial redactions below prove that only the exact redaction passes.
        """
        assert bool(_CREDENTIALED_URI.search(line)) is is_a_leak


class TestTheExamplesAreInsideEveryFileSet:
    """AT-090. Four lines of ``pyproject.toml``, asserted rather than assumed.

    Each of the four is invisible when wrong. ruff and mypy both report success over the files they were
    given, so an ``examples/`` directory missing from either list produces a green run that checked
    nothing in it. The sdist ``include`` decides whether a source download carries the examples at all,
    and nothing about building the package fails when it does not. The ``example`` marker is the one that
    fails loudly, under ``--strict-markers``, and it is asserted here so the set is read in one place.
    """

    def test_ruff_mypy_the_sdist_and_the_marker_all_know_about_examples(self) -> None:
        """The directory is in three file sets, and the marker is declared."""
        configuration = tomllib.loads(_PYPROJECT.read_text())
        tools = configuration["tool"]

        ruff_include = tools["ruff"]["include"]
        assert any(entry.startswith("examples") for entry in ruff_include), ruff_include
        assert "examples" in tools["mypy"]["files"], tools["mypy"]["files"]

        sdist_include = tools["hatch"]["build"]["targets"]["sdist"]["include"]
        assert "examples" in sdist_include, sdist_include

        markers = tools["pytest"]["ini_options"]["markers"]
        assert any(marker.startswith("example:") for marker in markers), markers
