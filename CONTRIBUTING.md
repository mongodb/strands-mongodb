# Contributing

Thanks for your interest in this project. Contributions of any size are welcome: a bug report, a fix, a
documentation correction, a new feature.

Read this first, and read [AGENTS.md](AGENTS.md) before you write code. This file is the process. That one
is the conventions the code has to follow, the commands, the test tiers, and the reasoning behind the
layout. It also lists what not to do, which is the shorter and more useful list.

## Reporting a bug

Search the existing issues first, including closed ones. When you open a new one, include:

- A reproducible test case or a sequence of steps.
- The version of this package, and which one: Python or TypeScript. For Python, the versions of
  `strands-agents` and of Python. For TypeScript, the versions of `@strands-agents/sdk`, of `mongodb` and of
  Node.js.
- Which MongoDB deployment you are on: Atlas, an Atlas CLI local deployment, or a self-managed server, and
  its version. Behaviour differs across the three, and the search tiers differ most.
- Anything unusual about the environment, and whether you have already tried the latest release.

Please do not report a security vulnerability in a public issue. See [Security](#security).

## Asking for a feature

Open an issue describing the problem before the solution. Say what you are trying to do and what is in the
way. If the request is about an API this package exposes, say which SDK surface you are wiring it into,
because both surfaces here implement protocols owned by the Strands Agents SDK and what they can do is
bounded by those.

## Setting up an environment

You need Python 3.10 or newer and, for anything beyond the default tier, a MongoDB deployment.

```bash
git clone git@github.com:mongodb/strands-mongodb.git
cd strands-mongodb/python
pip install hatch
hatch run test
```

That is where the repository lives today. It is expected to move to a MongoDB-owned organisation before the
first release, and the URLs in `pyproject.toml` already point at the intended home rather than at this one,
with a note beside them recording that the organisation is unconfirmed. Clone from wherever you found this
file.

Hatch builds the environment from `pyproject.toml`, so there is nothing else to install. If you would
rather use a plain virtualenv:

```bash
cd python
python -m venv .venv && source .venv/bin/activate
pip install -e ".[all,dev]"
python -m pytest
```

Either way, every command runs from `python/`, not from the repository root.

### TypeScript

You need Node.js 22 or newer and npm 11.21.3 or newer. Older npm 11 releases leave a native binding out of a
clean install, and the test runner then cannot start.

```bash
cd strands-mongodb/typescript
npm ci
npm run check
```

Every TypeScript command runs from `typescript/`, and `npm run check` is the counterpart of
`hatch run prepare`. [`typescript/README.md`](typescript/README.md#development) lists the rest.

## Running the tests

Most of the suite needs no deployment at all. The tiers that need one are gated on an environment
variable and skip when it is empty, so a first run on a laptop with no cluster is green.

| Tier | Gate | Needs |
|---|---|---|
| default | none | Nothing |
| `contract` | `MONGODB_URI` | Any MongoDB deployment |
| `integration` | `MONGODB_ATLAS_URI` | Atlas, or an Atlas CLI local deployment with `mongot` |
| `autoembed` | `MONGODB_AUTOEMBED_URI` | A cluster with an Atlas embedding model registered |
| `build` | `STRANDS_MONGODB_BUILD_TIER` | Network only. Builds a wheel and installs it into an empty venv |

Put the URIs in a `.env` file at the repository root, which is gitignored. Never commit one, and never
paste a connection string into an issue, a test or a document: a test in the suite walks every Markdown
file in the repository looking for exactly that.

Because `.env` is loaded automatically, a bare test run on a machine that has one starts the contract tier.
`AGENTS.md` explains how to opt out, and how long an index build and an embedding can take, which is worth
reading before you conclude that a cluster test has hung.

The TypeScript suite has the same tiers apart from `compat`, gated on the same variables, so one deployment
serves both. It reads them from the environment and from a `.env` file in `typescript/`, and its `npm test`
runs every tier whose variable is set.

## What a pull request has to pass

Run this before pushing. It is the same four checks the first two CI jobs run, in the same order, except
that it formats the tree in place where CI only reads it:

```bash
hatch run prepare
```

Or let git run the `Lint` checks for you. `.pre-commit-config.yaml` holds hooks that call the same
`hatch run format-check`, `hatch run lint` and `hatch run typecheck` the `Lint` job calls, so a
formatting or typing defect is caught before the commit exists rather than on the pull request:

```bash
pip install pre-commit
pre-commit install
```

Three more hooks do the same for TypeScript, calling `npm run format:check`, `npm run lint` and
`npm run typecheck` in `typescript/` when a commit touches it. They need its dependencies installed.

This is a local convenience and never the authority. A clone without it commits exactly as before, and
CI stays the thing that decides, which is why none of the hooks is a relaxed version of the CI check.
Run them over the whole tree at any time with `pre-commit run --all-files`.

Then the jobs in `.github/workflows/ci-python.yml`. Five gate a change, one of them twice over two
deployments, so six checks have to go green; two more jobs run on the weekly cron, or whenever a maintainer
starts the workflow by hand from the Actions tab:

| Job | Runs |
|---|---|
| `Lint` | `hatch run format-check`, `hatch run lint`, `hatch run typecheck` |
| `Test - Python <version>` | The default tier on 3.10, 3.11, 3.12, 3.13 and 3.14. No deployment, so no secrets |
| `Contract tier (<deployment>)` | `hatch run test -m contract` twice, against a `mongo:8` service container and against a `mongodb/mongodb-atlas-local:8` one that carries a search process. The second leg also runs `hatch run test -m integration`, which needs that search process. No secret either time |
| `Coverage floors` | `hatch run cov`: 90% aggregate and 70% per module, both enforced |
| `Dependency floors` | Installs the oldest version of every dependency the manifest declares, on the oldest Python it claims, then runs the default tier against them |
| `Latest SDK compatibility` | Weekly or on demand, against the newest published `strands-agents` rather than the pinned one. Typechecks, then runs `compat`, then runs `contract` |
| `Atlas tiers` | Weekly, or on demand. Creates an Atlas cluster for the run, runs `hatch run test -m "integration or autoembed"` against it, and deletes it |

![Where each test tier runs: the unit and contract tiers and the integration tier on every change, the Atlas tiers on a throwaway cluster weekly or on demand](docs/images/ci-tiers.png)

Every change gets the `integration` tier, from a fork as readily as from a branch, because the Atlas local
container carries the search process it needs. Only `autoembed` needs a real Atlas cluster: automated
embedding runs on Atlas, on an M10 or larger with storage auto-scaling on. So the `Atlas tiers` job creates
one for each run, on the newest MongoDB release, and deletes it when the run ends, pass or fail. It runs on
the weekly cron and when a maintainer starts the workflow by hand, never on a pull request: a fork receives no
secret, and every run is billed for the hour or so its cluster exists. A pull request that changes automated
embedding should say whether the author ran `autoembed` locally.

A change under `typescript/` runs `.github/workflows/ci-typescript.yml` instead: lint and typecheck, the
unit tier on Node.js 22 and 24, the contract, integration and example tiers against the same two
service containers, and the coverage floors with the build tier. The job table is in
[`typescript/README.md`](typescript/README.md#continuous-integration), where a test holds it to the workflow.
None of those jobs holds a secret. Nothing in that workflow runs `autoembed` yet, so a TypeScript change to
automated embedding should say whether the author ran that tier locally.

### The cluster the `Atlas tiers` job creates

The job runs [`python/scripts/atlas_ci_cluster.py`](python/scripts/atlas_ci_cluster.py), which you can also
run yourself. `up` creates an M10 named `sm-ci-<suffix>`, a database user and an access-list entry for
the machine running it (both expire after three hours), waits until the search process answers, and prints
the connection string. `down <name>` deletes the cluster and the user. `up` also deletes any `sm-ci-`
cluster older than three hours, in case a run stopped before its teardown.

It authenticates the way the Atlas CLI does: a logged-in `atlas auth login` session locally, and in CI a
service account with the Project Owner role on one Atlas project, which is what creating a cluster takes. The
workflow reads three repository secrets:

- `ATLAS_CLIENT_ID`: the service account's client ID.
- `ATLAS_CLIENT_SECRET`: its client secret.
- `ATLAS_PROJECT_ID`: the project the cluster is created in.

## Sending the pull request

1. Work against `main` and keep the change focused on one thing.
2. **Add or update a test** that fails without your change.
3. **Update the documentation if behaviour changed.** `python/README.md` and `typescript/README.md` are the
   references a user reads.
4. Use a conventional commit subject: `feat:`, `fix:`, `docs:`, `test:`, `refactor:` or `chore:`.
5. Run `hatch run prepare`, or `npm run check` for a TypeScript change, and make sure it is clean.
6. Open the pull request against `main`, describe what changed and why, and mention any issue it closes.
7. Stay engaged with review. Squash and rebase if asked.

## Code of conduct

This project follows the [MongoDB Code of Conduct](https://www.mongodb.com/community-code-of-conduct). The
short version is the ordinary standard: be respectful, assume good faith, and keep discussion on the work.

Report a violation to community@mongodb.com, which is the address that document names. Not in an issue and
not in a pull request review, because neither is private and neither reaches anybody who can act on it.

## Security

**Do not open a public issue for a security vulnerability.** A public report discloses the vulnerability
before a fix exists.

Report it privately to mongodb-partners@mongodb.com instead. [SECURITY.md](SECURITY.md) is the same address
with the detail beside it: what to put in the report, what to expect back, and what is out of scope here,
including MongoDB Server, Atlas and the drivers, which go through MongoDB's own process rather than through
this repository.

## Licensing

This project is licensed under Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

Contributions are accepted under the same license. Larger changes may need a Contributor License Agreement,
and a maintainer will say so on the pull request if it applies.
