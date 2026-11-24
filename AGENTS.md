# Working in this repository

The rules that apply every time you touch the code. [CONTRIBUTING.md](CONTRIBUTING.md) is the process
around a change: how to set up, what a pull request has to pass, where to report a bug. This file is what
the change itself has to look like.

Written for whoever arrives next, human or agent. Where a rule can be checked by a tool it is, and the
test that checks it is named, because a convention nothing measures is a preference.

## Layout

One repository, two packages with one name: `strands-mongodb` for PyPI from `python/`, and
`strands-mongodb` for npm from `typescript/`, which no release workflow publishes yet. The two write the
same documents, create the same indexes and emit the same span and log-event names, so one deployment serves
agents in both languages, and tests on the TypeScript side compare against the Python package to keep it
that way.

| Path | Holds |
|---|---|
| `python/` | The Python package. `src/`, `tests/`, `examples/`, `pyproject.toml`, and the reference `README.md` and `MIGRATION.md` |
| `typescript/` | The TypeScript package. Its source, tests and examples, `typescript/package.json`, and the reference `typescript/README.md` |
| `.github/workflows/ci-python.yml` | Every gate a pull request to `python/` meets |
| `.github/workflows/ci-typescript.yml` | Every gate a pull request to `typescript/` meets |
| `README.md` | The landing page. Short on purpose: `python/README.md` and `typescript/README.md` are the references |
| `docs/images/` | The diagrams the READMEs and `CONTRIBUTING.md` show, as PNG |
| `AGENTS.md`, `CONTRIBUTING.md` | This file and the process |

Everything with a version number lives under `python/` or `typescript/`, and each tree carries its own version.
This file has a section per language rather than a copy per language, because a split is how two files that
describe one repository start disagreeing. The sections from Commands to House conventions describe
`python/`; [TypeScript](#typescript) describes `typescript/` in the same order. The rest applies to both.

## Where the reasoning lives, and how tests are tagged

The tests are the record of what this package guarantees. A change in behaviour comes with the test that
proves it, written first, and the reason for a non-obvious choice lives in the code that makes it.

**Every test names the item it proves, in the first paragraph of its docstring.** Either its own docstring
or its class's:

```python
async def test_a_bound_above_the_lowest_score_drops_exactly_that_result(self) -> None:
    """AT-059b. Measure first, then bound just above the measurement's floor."""
```

The release gate in `tests/conftest.py` collects these tags to decide which checklist items have evidence.
It reads the first paragraph only, so that a later sentence such as "this tier does not cover X" is never
counted as evidence that X is covered. Use the tag nowhere else: comments, later paragraphs and the
documentation describe the behaviour in words.

TypeScript has no docstrings, so there the id opens the test's title, or its `describe` block's:
`it('AT-021 — ...')` counts, and `it('reads ... (AT-021)')` does not. The id is a checklist id from
`typescript/test/checklist.ts`, which a test in `typescript/test/gate/gate.test.ts` holds equal to Python's
checklist, or a `TS-` id for a behaviour the checklist does not list. A leading id that is neither fails the
gate, so a typo cannot pass as evidence.

A `TODO(...)` in a file names the thing that has to be settled before the placeholder can go, and the test
suite asserts that every placeholder in this file and in `CONTRIBUTING.md` names something, as TS-162 does for
every file under `typescript/`. Do not write a bare `TODO`.

## Commands

Every command runs from `python/`. [Hatch](https://hatch.pypa.io) builds the environment from
`pyproject.toml`, so nothing needs installing first.

| Command | Does |
|---|---|
| `hatch run test` | The suite. Arguments pass through, so `hatch run test tests/test_storage.py -x` works |
| `hatch run lint` | Ruff, over `src/`, `tests/`, `scripts/` and `examples/` |
| `hatch run format` | Ruff's formatter, in place |
| `hatch run format-check` | The same, read-only. What CI runs |
| `hatch run typecheck` | Mypy, over the same four directories |
| `hatch run cov` | The suite plus both coverage floors: 90% aggregate and 70% per module |
| `hatch run prepare` | `format`, `lint`, `typecheck`, `test`, in that order. Run this before pushing |

Pass no path to `lint` or `typecheck`. An explicit path overrides the file list in `pyproject.toml`, which
is the one list both tools read.

`cov` is deliberately not part of `test`. A floor that fails on a half-finished module trains everyone to
reach for `--no-cov`, so `test` stays runnable at any point mid-change and `cov` is the release gate.

Working in a plain virtualenv instead is fine: `pip install -e ".[all,dev]"` from `python/` installs the
same set, and `python -m pytest` replaces `hatch run test`. Python 3.10 is the floor, so use an
interpreter at 3.10 or newer.

## Test tiers

Most of the suite needs nothing. The tiers that need a deployment are gated on an environment variable
being non-empty, and a tier whose variable is unset skips rather than fails, so a first run on a laptop
with no cluster is green and fast.

| Marker | Gate | Needs |
|---|---|---|
| unmarked | none | Nothing. Around 700 tests, roughly 50 seconds |
| `contract` | `MONGODB_URI` | Any MongoDB deployment, including a local one |
| `integration` | `MONGODB_ATLAS_URI` | Atlas, or an Atlas CLI local deployment with `mongot` |
| `autoembed` | `MONGODB_AUTOEMBED_URI` | An Atlas cluster that runs automated embedding: M10 or larger, storage auto-scaling on. `python/scripts/atlas_ci_cluster.py up` creates one |
| `build` | `STRANDS_MONGODB_BUILD_TIER` | Network. Builds a wheel and installs it into an empty venv. No deployment and no secret |
| `compat` | none, CI cron or dispatch only | Resolves the latest published `strands-agents` rather than the pinned one |
| `example` | its backend's tier | Runs a shipped `examples/` script as a subprocess |
| `gate` | none | The release-gate assertion. Ordered last, so it sees every other outcome |

The variables are read from the process environment, and also from a `.env` file beside this one if you
keep one there. `.env` is gitignored and must stay that way: it holds a connection string with a password
in it.

**The gotcha that will get you once.** Because `.env` is loaded automatically, a bare `hatch run test` on a
machine that has one starts the contract tier, which takes minutes rather than seconds. Opting out means
setting the variables to **empty**, not unsetting them:

```bash
MONGODB_URI= MONGODB_ATLAS_URI= MONGODB_AUTOEMBED_URI= hatch run test
```

To run one tier on purpose, select it: `hatch run test -m contract`, or `hatch run test -m "not integration"`
to keep everything else. `--strict-markers` is on, so a marker that is not registered in `pyproject.toml`
is a collection error rather than a silently ignored decorator. Register it there before you use it.

Two things to know before you wait on a cluster. A first `add()` against a collection with no search index
creates two indexes and waits for both to report `READY`, which takes minutes. A document is then not
searchable the instant its write returns, because the search process indexes it asynchronously. Test
helpers poll to a 180-second ceiling rather than sleeping, so a fast cluster is not slowed down.

## House conventions

The Strands Python SDK's own contributor guide is where these come from. Seven of the nine are checked by a
tool or a test, and the table names which. The two that are not are review's job, and saying so is more
useful than pretending otherwise.

| Convention | Checked by |
|---|---|
| `X \| None`, never `Optional[X]` | `tests/test_conventions.py` |
| `TypedDict` or `dataclass` for structure. No pydantic, no runtime validator | `tests/test_conventions.py` |
| An explicit `__all__` in every module, so the public surface is a decision | `tests/test_conventions.py` |
| `%s` placeholders in log calls, never an f-string | Ruff's `G` rules, and `tests/test_conventions.py` asserts they are selected |
| `warnings.warn` always passes `stacklevel`, so the warning points at the caller | `tests/test_conventions.py`, written for the first call anyone adds |
| A `Raises:` section on anything public that raises | `tests/test_conventions.py`, over every public function and method |
| Google-style docstrings. `snake_case` functions, `_leading_underscore` for private | Review |
| No `asyncio.TaskGroup` or `asyncio.timeout` without a version gate. Both are 3.11+ and the floor is 3.10 | `tests/test_conventions.py` |
| Conventional commit subjects (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`) | Review. `CONTRIBUTING.md` has the format |

**One deviation, and it is deliberate.** The SDK's log messages are shaped
`field=<%s>, other=<%s> | lowercase message`. This package does not copy that shape, and writes
`strands_mongodb: ` followed by a sentence with `%s` placeholders in it:

```python
_SCORE_BOUND_APPLIED = "strands_mongodb: %s %r on %s kept %d of %d results (applied after the query)."

logger.debug(_SCORE_BOUND_APPLIED, name, bound, self._target, len(kept), len(scored))
```

Message bodies are module constants with docstrings of their own, not literals inside the call. That is
where the reason for a message lives, and it is also what lets a test assert on one without copying the
string.

Two reasons, both about being a third-party integration rather than the SDK itself. The prefix names the
package in a log stream where the logger name is usually not rendered, and several of these messages are
explanatory rather than a field list: the one for a deployment with no Atlas Search names the server error
code the probe saw and what to do about it, which does not fit a key-value line. Every log call in the
package follows this shape, and `tests/test_telemetry.py` pins each one, so reshaping them is a change with
tests to update rather than a matter of taste. Placeholders stay `%s`: that half of the rule is enforced by ruff.

Every log call also passes `extra=_telemetry.event_extra(...)`, which adds `strands_mongodb_event` and,
where the record is about one, `strands_mongodb_namespace` and `strands_mongodb_tier`. A new call needs a
new name in `_telemetry.LogEvent`, and `tests/test_telemetry.py` fails on a call that skips the helper.
Spans go through `_telemetry.traced` or `_telemetry.span`, and an attribute is recorded only if it is in
`_telemetry.Attribute`, the allow-list; anything else is dropped with a `DEBUG` record. Never add an
attribute that carries caller data: a key, content, metadata, query text, filter values, a scope or a
memory id. The README's observability section lists every span, attribute and event, and
`tests/test_readme.py` fails until a new one is named there.

## TypeScript

The same package for the TypeScript SDK, held to the same rules. Python's tests are its specification: a
module in `typescript/src/` ports its Python counterpart, and its test file ports the Python test file, so a
reviewer can read one beside the other. Where the two languages force a different choice, the module's
header comment says what differs and why.

### Commands

Every command runs from `typescript/`. Install with `npm ci`, using npm 11.21.3 or newer: older npm 11
releases leave Vitest's native binding out of a clean install, and the suite then cannot start. CI installs
that version before every `npm ci`, and `typescript/test/unit/ci.test.ts` pins it there.

| Command | Does | Python counterpart |
|---|---|---|
| `npm test` | Every tier. Arguments pass through, so `npm test -- --project contract` runs one | `hatch run test` |
| `npm run lint` | ESLint with typescript-eslint, over the whole package | `hatch run lint` |
| `npm run format` | Prettier, in place | `hatch run format` |
| `npm run format:check` | The same, read-only. What CI runs | `hatch run format-check` |
| `npm run typecheck` | `tsc --noEmit` over the source, tests, scripts and examples | `hatch run typecheck` |
| `npm run build` | Compiles the source with its declaration files. `npm pack` runs it first | None |
| `npm run cov` | Every tier plus both coverage floors: 90% aggregate and 70% per file | `hatch run cov` |
| `npm run check` | `format:check`, `lint`, `typecheck`, then the unit tier, in that order. Run this before pushing | `hatch run prepare` |

The last one is called `check` rather than `prepare` because `prepare` is an npm lifecycle script that runs
on every `npm install`. It reads the formatting rather than rewriting it, so run `npm run format` first if
it fails there.

### Test tiers

The same tiers, gated on the **same environment variables**. That is a requirement rather than a taste:
`tests/test_conventions.py` fails this file if it names a variable no Python gate reads, and one variable
pointing at a deployment runs both suites against it. Each tier is a Vitest project, and a test file belongs
to the one whose directory under `typescript/test/` holds it.

| Project | Gate | Needs |
|---|---|---|
| `unit` | none | Nothing. Around a thousand tests |
| `contract` | `MONGODB_URI` | Any MongoDB deployment, including a local one |
| `integration` | `MONGODB_ATLAS_URI` | Atlas, or an Atlas CLI local deployment with `mongot` |
| `autoembed` | `MONGODB_AUTOEMBED_URI` | A cluster that runs automated embedding, as for Python |
| `build` | `STRANDS_MONGODB_BUILD_TIER` | Network. Packs the tarball, checks its file list, installs it into an empty project and imports it |
| `example` | its backend's tier | Runs a shipped example script as a subprocess |
| `gate` | none | The release gate. Run with the others in one invocation, so it sees every other outcome |

Python's `compat` tier has no TypeScript counterpart yet: nothing runs the suite against the newest published
`@strands-agents/sdk` rather than the locked one.

A tier whose variable is empty skips, with the variable named in the skipped test's title. The variables are
read from the environment and from a `.env` file in `typescript/`, which is gitignored, and a value already in
the environment wins even when it is empty. So the gotcha above holds here too, and the opt-out is the same:

```bash
MONGODB_URI= MONGODB_ATLAS_URI= MONGODB_AUTOEMBED_URI= npm test
```

Vitest has no `--strict-markers`. TS-007 in `typescript/test/unit/tiers.test.ts` is the equivalent: it fails
on a test file outside every project's directory, and on a tier gated on a variable the Python suite does not
use. The cluster facts are the same as well: helpers poll to a 180-second ceiling, and tests work only in
databases they create, named `strands_mongodb_test_` and eight random hex characters, and drop them at the end.

The release gate is split in two, because a test in a worker cannot see another project's outcome. The `gate`
project holds the half that needs no results: the checklist equals Python's, and every leading id resolves.
A Vitest reporter in `typescript/test/support/gate-reporter.ts` holds the other half, and fails the run when a
gate item has no passing test. It reports a skipped item as unverified, never as passed, as Python's gate does.

### House conventions

Python's conventions, translated. As above, each one names what checks it, and the TS ids are in
`typescript/test/unit/conventions.test.ts` unless another file is named.

| Convention | Checked by |
|---|---|
| A configuration key is absent one way, as an optional property, never `null`. `null` only where the SDK's contract returns it | TS-164 |
| Interfaces and type aliases for structure. No runtime schema library, which is "no pydantic" translated | TS-165, over the imports in the source and the dependencies the package declares |
| An explicit export list in the entry point, never `export *`, so the public surface is a decision | ESLint's `no-restricted-syntax`, and TS-154 in `typescript/test/unit/readme.test.ts`, which compares the exports with the README's API table |
| A log message is a named message function with a doc comment of its own, never assembled where it is logged | TS-166 |
| A `@throws` tag on every exported function and public member whose body throws | TS-167, which walks the declarations with the TypeScript compiler |
| TSDoc on everything exported. camelCase members, and `#private` or a leading underscore for internals | ESLint's `naming-convention` for the names. Review for the prose |
| No API above the Node 22 floor without a guard | `@types/node` is held to Node 22, so the type checker rejects one, and CI's Node 22 leg runs it |
| Conventional commit subjects | Review, as for Python |

Configuration keys are camelCase, because they are TypeScript properties. Document fields, log fields, span
attributes and operation names keep Python's snake_case spelling, because they are on disk or on the wire, and
a document written by one package has to read the same from the other.

Errors follow the SDK rather than Python's `ValueError`. A caller's mistake is a `RangeError` for a number out
of range, a `TypeError` for a value of the wrong shape, and a plain `Error` otherwise, and its message opens
with the class name, as the SDK's own do. A failure reaching or using the database is the SDK's
`StorageError`, with the driver's error as its `cause`. Messages from the modules both stores share keep the
`strands_mongodb: ` prefix.

Logging keeps the Python shape. Each call passes `eventFields(...)` first, which carries
`strands_mongodb_event` and, where they apply, the namespace and tier fields, then the message: Pino's
argument order. TS-020 in `typescript/test/unit/telemetry.test.ts` fails on a call that skips the helper,
and TS-019 fails when the span names, attributes or log events differ from those in
`python/src/strands_mongodb/_telemetry.py`. The rule that no span attribute carries caller data is unchanged,
and `typescript/test/unit/readme.test.ts` fails until a new span, attribute or event is named in the README's
observability section.

## What not to do

- **Do not silence a warning to make a run quiet.** Two known ones are tracked and neither is ours to fix:
  `pytest-asyncio` 0.26 calling a deprecated event-loop API, and pymongo closing a periodic executor in a
  weakref callback after the loop has gone. A
  `filterwarnings` entry that hides those also hides the next one, which will be ours.
- **Do not put a connection string in a document, a test or an example.** `tests/test_conventions.py` walks every Markdown file
  in the repository looking for one with credentials in it. TS-161 in `typescript/test/unit/conventions.test.ts`
  walks the same files and every file under `typescript/` as well. The examples in both trees redact the
  userinfo before they print a URI.
- **Do not infer an SDK API.** Read the installed `strands` package. The floor is `strands-agents` 1.54.0
  because that is the first release with every module this package imports, and a guess about an earlier
  release is a guess about somebody's install. Do not raise or lower a floor by reading a changelog either:
  the `Dependency floors` job installs the declared floors and runs the suite against them, which is the only
  check of what the code actually needs. In TypeScript, read the installed `@strands-agents/sdk` and `mongodb`
  under `typescript/`. What the SDK does not export is copied and tested against its public behaviour, never
  imported from a deep path, which can typecheck and then fail at runtime. There is no TypeScript floors job
  yet, so the peer floors in `typescript/package.json` are the ones the package started with, not the lowest
  that pass.
- **Do not hand-edit the index and privilege commands in `python/README.md`.** They are compared against the
  renderer in `src/strands_mongodb/_indexes.py` that produces them, so an edit there fails a test rather
  than shipping a command the package does not run. The TypeScript renderer is compared against the same
  block, and the block in `typescript/README.md` against that renderer, so neither README is edited by hand.
- **Do not add a runtime dependency to `dependencies`.** It is empty on purpose. Every dependency belongs to
  the extra that needs it, so `pip install 'strands-mongodb[storage]'` never pulls vector-search machinery.
  In `typescript/package.json` it is empty too, for a different reason: the driver, the SDK and the
  OpenTelemetry API are peer dependencies, so an application holds one copy of each. A second `mongodb` would
  be a second connection pool. The build tier asserts that the packed manifest declares none.
- **Do not skip a test to get to green.** A skip and a pass are the same colour.
