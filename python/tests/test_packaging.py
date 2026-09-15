"""Characterization tests for the declared and resolved package metadata.

Covers ``CH-002`` (``INV-002``) and ``CH-006`` (``INV-006``), and stands at boundary **B-9**:
declared manifest to resolved distribution. Both sides are asserted, because they disagree in ways
that matter.

``importlib.metadata`` reads what pip actually installed. That is the stronger assertion for
dependency and extra questions, and it is the only one that catches a manifest whose extras resolve
differently than they read. The manifest is read directly only for properties the build **erases**:
hatchling flattens the self-referential ``all`` extra, and ``hatch-vcs`` reports a fallback version
outside a git repository.
"""

from __future__ import annotations

import sys
from importlib.metadata import metadata
from pathlib import Path
from typing import TYPE_CHECKING, Any

import pytest

if TYPE_CHECKING:
    import subprocess
    from collections.abc import Callable

    # Imported for annotations only. It is re-exported from `importlib.metadata` on every supported
    # interpreter, but it is a protocol defined in a private submodule, so keeping the import out of
    # runtime avoids depending on that re-export staying put.
    from importlib.metadata import PackageMetadata

if sys.version_info >= (3, 11):
    import tomllib
else:  # pragma: no cover - exercised only on the 3.10 floor
    tomllib = None  # type: ignore[assignment]

DISTRIBUTION = "strands-mongodb"

# tests/ -> python/
PROJECT_ROOT = Path(__file__).resolve().parent.parent
PYPROJECT = PROJECT_ROOT / "pyproject.toml"


def _requirements_by_extra(dist_metadata: PackageMetadata) -> dict[str, set[str]]:
    """Group ``Requires-Dist`` entries by the extra that gates them.

    Args:
        dist_metadata: Metadata of the installed distribution.

    Returns:
        A mapping of extra name to the set of requirement specifiers it pulls in. Ungated
        requirements are collected under the empty string.
    """
    by_extra: dict[str, set[str]] = {}
    for requirement in dist_metadata.get_all("Requires-Dist") or []:
        spec, _, marker = requirement.partition(";")
        extra = marker.strip().removeprefix("extra ==").strip().strip("'\"")
        by_extra.setdefault(extra, set()).add(spec.strip())
    return by_extra


def _distribution_names(specifiers: set[str]) -> set[str]:
    """Strip version constraints, leaving bare distribution names.

    Args:
        specifiers: Requirement specifiers such as ``pymongo>=4.12.0``.

    Returns:
        The distribution names alone.
    """
    return {spec.split(">")[0].split("<")[0].split("=")[0].split("[")[0].strip() for spec in specifiers}


@pytest.fixture(scope="module")
def dist_metadata() -> PackageMetadata:
    """Metadata of the installed distribution."""
    return metadata(DISTRIBUTION)


@pytest.fixture(scope="module")
def manifest() -> dict[str, Any]:
    """Parsed ``pyproject.toml``.

    Skips rather than fails on the 3.10 floor, where ``tomllib`` is absent from the standard
    library. Adding ``tomli`` as a test dependency to read our own manifest is not worth it; the
    assertions that need the manifest are about build configuration, which CI on any newer
    interpreter covers.
    """
    if tomllib is None:
        pytest.skip("tomllib needs Python 3.11+; manifest assertions run on the newer interpreters")
    return tomllib.loads(PYPROJECT.read_text())


class TestExtras:
    """CH-002 / INV-002 — three runtime extras, plus dev, and ``all`` is their union."""

    def test_declares_the_expected_extras(self, dist_metadata: PackageMetadata) -> None:
        """Exactly four extras: three runtime surfaces and ``dev``.

        ``dev`` counts. An earlier draft of ``INV-002`` said "exactly three extras" and would have
        failed against the package as built.
        """
        assert sorted(dist_metadata.get_all("Provides-Extra") or []) == ["all", "dev", "memory", "storage"]

    def test_base_install_has_no_runtime_dependency(self, dist_metadata: PackageMetadata) -> None:
        """REQ-E-001 — every ``Requires-Dist`` entry is gated behind an extra.

        A dependency that slipped out of an extra would be installed by a bare
        ``pip install strands-mongodb``, which is exactly what the extras exist to prevent.
        """
        assert _requirements_by_extra(dist_metadata).get("", set()) == set()

    def test_all_is_the_union_of_storage_and_memory(self, dist_metadata: PackageMetadata) -> None:
        """``[all]`` cannot resolve to a split pair, because it names nothing of its own.

        This is the observable form of the self-referential ``all``. Hatchling flattens
        ``strands-mongodb[memory,storage]`` into the resolved dependency list at build time, so the
        self-reference itself is invisible here (see ``test_all_extra_is_self_referential``). The
        union property is what protects the user and it survives the flattening.
        """
        by_extra = _requirements_by_extra(dist_metadata)

        assert by_extra["all"] == by_extra["storage"] | by_extra["memory"]

    def test_memory_extra_is_a_superset_of_storage(self, dist_metadata: PackageMetadata) -> None:
        """REQ-E-002 — ``[memory]`` adds ``pymongo-search-utils`` and nothing else."""
        by_extra = _requirements_by_extra(dist_metadata)

        assert _distribution_names(by_extra["memory"] - by_extra["storage"]) == {"pymongo-search-utils"}

    def test_storage_extra_pulls_no_search_machinery(self, dist_metadata: PackageMetadata) -> None:
        """REQ-E-002 — the point of splitting the extras, asserted directly.

        The union test above would still pass if ``[storage]`` quietly gained
        ``pymongo-search-utils``, since the union would simply be equal. This is the assertion that
        the split buys the user something.

        ``typing-extensions`` joined this set in Task 1 (see
        ``test_every_directly_imported_third_party_module_is_declared``).
        """
        by_extra = _requirements_by_extra(dist_metadata)

        assert _distribution_names(by_extra["storage"]) == {"strands-agents", "pymongo", "typing-extensions"}

    def test_every_directly_imported_third_party_module_is_declared(self, dist_metadata: PackageMetadata) -> None:
        """REQ-E-002 — a dependency we ``import`` is one we name, not one we inherit.

        ``types.py`` imports ``Required`` and ``TypedDict`` from ``typing_extensions``, because
        ``typing.Required`` is 3.11+ and the declared floor is 3.10. It resolves today whether or not
        we ask for it: ``strands-agents`` pins ``typing-extensions>=4.13.2,<5.0.0`` unconditionally
        and is in both runtime extras.

        Relying on that is the thing this test rejects. A transitive pin is a fact about someone
        else's current release, not a promise to us, and the failure it produces is a bare
        ``ModuleNotFoundError`` at import in a resolution nobody tested. Both extras name it, so
        ``INV-002`` is unaffected: neither surface gained a dependency the other lacks.
        """
        by_extra = _requirements_by_extra(dist_metadata)

        for extra in ("storage", "memory"):
            assert "typing-extensions" in _distribution_names(by_extra[extra]), sorted(by_extra[extra])

    def test_all_extra_is_self_referential_in_the_manifest(self, manifest: dict[str, Any]) -> None:
        """The manifest expresses ``all`` by reference, so the union cannot drift by editing one list.

        Asserted against the source, since the built metadata has this flattened away. Both
        assertions are needed: this one keeps the mechanism, the union test keeps the outcome.
        """
        assert manifest["project"]["optional-dependencies"]["all"] == ["strands-mongodb[memory,storage]"]

    def test_dev_extra_declares_a_coverage_tool(self, dist_metadata: PackageMetadata) -> None:
        """REQ-E-005 — the coverage floor is a release gate, so the tool that measures it is declared.

        The scaffold declared a 90% floor in the plan and no ``pytest-cov`` in ``dev``. A gate no
        installed tool can measure is not a gate.
        """
        dev = _requirements_by_extra(dist_metadata)["dev"]

        assert "pytest-cov" in _distribution_names(dev), sorted(dev)


class TestCoreMetadata:
    """CH-006 / INV-006 — interpreter floor, SDK floor, license, version source."""

    def test_requires_python_floor_is_3_10(self, dist_metadata: PackageMetadata) -> None:
        """The floor the classifiers and the mypy target both assume."""
        assert dist_metadata["Requires-Python"] == ">=3.10"

    def test_license_is_an_apache_2_expression(self, dist_metadata: PackageMetadata) -> None:
        """PEP 639 license expression, matching the extension template's own declaration."""
        assert dist_metadata["License-Expression"] == "Apache-2.0"

    @pytest.mark.parametrize("extra", ["storage", "memory"])
    def test_strands_agents_floor_is_1_48_on_both_runtime_extras(
        self, dist_metadata: PackageMetadata, extra: str
    ) -> None:
        """1.48.0 is the first release shipping ``strands.storage``.

        Applied to both extras deliberately, though ``strands.memory`` landed in 1.44.0, so ``[all]``
        cannot resolve to a split pair.
        """
        requirements = [r for r in (dist_metadata.get_all("Requires-Dist") or []) if f"extra == '{extra}'" in r]
        floors = [r for r in requirements if r.startswith("strands-agents")]
        assert floors, requirements
        assert all(">=1.48.0" in r for r in floors), floors

    def test_version_is_derived_from_a_git_tag_not_a_file(self, manifest: dict[str, Any]) -> None:
        """INV-006's version half, asserted against the manifest.

        The installed distribution reports ``0.0.0`` here, because this workspace is not a git
        repository and ``hatch-vcs`` falls back. Asserting the resolved version would assert the
        fallback, which is the opposite of the invariant.
        """
        assert manifest["project"]["dynamic"] == ["version"]
        assert "version" not in manifest["project"]
        assert manifest["tool"]["hatch"]["version"]["source"] == "vcs"

    def test_release_tags_are_namespaced_to_the_python_artifact(self, manifest: dict[str, Any]) -> None:
        """``python-v*``, so a future TypeScript half versions independently off the same repo."""
        raw_options = manifest["tool"]["hatch"]["version"]["raw-options"]
        assert raw_options["tag_regex"] == "^python-v(?P<version>.+)$"
        assert raw_options["root"] == ".."

    def test_untagged_builds_are_unmistakable(self, manifest: dict[str, Any]) -> None:
        """The fallback version is ``0.0.0``, which no release will ever be."""
        assert manifest["tool"]["hatch"]["version"]["raw-options"]["fallback_version"] == "0.0.0"


class TestBuildPathsResolveInsideTheProjectRoot:
    """REQ-E-003 — the defect that made the scaffold unbuildable.

    ``pyproject.toml`` declared ``readme = "README.md"`` and ``license-files = ["LICENSE", "NOTICE"]``
    while all three files lived at the repository root, one directory above the project root.
    ``pip install -e .`` failed at metadata generation with
    ``OSError: Readme file does not exist: README.md``, so 0.0.1 was never built and never published.
    """

    @pytest.mark.parametrize("filename", ["README.md", "LICENSE", "NOTICE"])
    def test_referenced_file_exists_in_the_project_root(self, filename: str) -> None:
        """Every path the manifest references resolves without escaping ``python/``."""
        assert (PROJECT_ROOT / filename).is_file(), f"{filename} missing from {PROJECT_ROOT}"

    def test_manifest_references_those_files_by_relative_name(self, manifest: dict[str, Any]) -> None:
        """No ``../`` in the readme or license paths: a build backend rejects paths outside the root."""
        assert manifest["project"]["readme"] == "README.md"
        assert manifest["project"]["license-files"] == ["LICENSE", "NOTICE"]


class TestTheDistributionAdvertisesItsTypes:
    """AT-007c / REQ-E-007a — the PEP 561 marker, and the consequence of shipping without it.

    Found by running the Task 1 demo from a directory outside the project. ``mypy`` on a snippet with
    a ``MongoDBConfig`` literal missing its ``Required`` ``database`` key exited **0**. Not because
    the type was wrong: because the package carried no ``py.typed``, so mypy declined to read any of
    it and made every symbol ``Any``.

    That makes the marker load bearing for the whole typing story rather than a packaging detail.
    ``Required`` keys, the narrow ``SearchType`` literal and the ``TYPE_CHECKING`` declarations behind
    ``REQ-E-007`` are all instructions to a consumer's type checker, and a consumer's type checker
    reads none of them without it. Every reference ships one: ``strands`` itself, the extension
    template this package was scaffolded from, and ``pymongo``.
    """

    def test_the_marker_file_exists_in_the_package(self, dist_metadata: PackageMetadata) -> None:
        """A file whose presence is the entire signal (PEP 561), asserted next to the claim it backs.

        The manifest has carried the ``Typing :: Typed`` classifier since the scaffold, so the
        omission was two lines of one file disagreeing rather than a decision. The classifier is a
        claim on PyPI and the marker is the mechanism; asserting both together is what keeps them from
        drifting apart again in either direction.
        """
        assert "Typing :: Typed" in (dist_metadata.get_all("Classifier") or [])
        assert (PROJECT_ROOT / "src" / "strands_mongodb" / "py.typed").is_file()

    def test_the_marker_sits_inside_the_directory_the_wheel_packages(self, manifest: dict[str, Any]) -> None:
        """Placement is what ships it, and misplacing it fails silently.

        ``hatchling`` includes every file under the declared package directory, so no explicit
        ``artifacts`` or ``force-include`` entry is needed. A marker one level up in ``src/`` would
        satisfy the test above and never reach the wheel.

        The stronger form of this assertion inspects a built wheel. That needs a build backend this
        environment does not install, so the release workflow's own build step is where it belongs.
        """
        packages = manifest["tool"]["hatch"]["build"]["targets"]["wheel"]["packages"]

        assert "src/strands_mongodb" in packages

    def test_a_consumer_type_checker_reads_our_required_keys(
        self, run_mypy_as_installed: Callable[[str], subprocess.CompletedProcess[str]]
    ) -> None:
        """The failure the marker actually prevents, asserted the way a consumer would hit it.

        Resolved through the install with no ``MYPYPATH``, this is the only test in the suite that can
        fail on a missing marker. The rest set ``MYPYPATH`` and analyze ``src`` directly, which is a
        path PEP 561 does not gate, so all of them pass either way.

        The positive half matters as much as the negative one. A missing marker produces exit 1 too,
        from ``import-untyped``, so the returncode alone proves nothing.
        """
        result = run_mypy_as_installed(
            """
            from strands_mongodb.types import MongoDBConfig

            config: MongoDBConfig = {"connection_string": "mongodb://localhost"}
            """
        )

        assert "import-untyped" not in result.stdout, result.stdout
        assert 'Missing key "database" for TypedDict "MongoDBConfig"' in result.stdout, result.stdout
