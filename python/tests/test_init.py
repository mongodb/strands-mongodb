"""Characterization tests for the top-level package surface.

Written against the 0.0.1 scaffold **before** any source file moves, so they document what the
package actually does rather than what the implementation is about to do. That is what makes them a
regression net: a test written after the change describes the change and can only ever pass.

Covers ``CH-001`` (``INV-001``), ``CH-004`` (``INV-004``) and ``CH-005`` (``INV-005``).
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

import strands_mongodb

# tests/ -> python/ -> python/src
SRC = Path(__file__).resolve().parent.parent / "src"


class TestPublicSurface:
    """CH-001 / INV-001 — which names live where."""

    def test_top_level_declares_both_backends_and_the_version(self) -> None:
        """``__all__`` describes the public surface, which is now three names.

        The scaffold declared ``["__version__"]`` alone, and this test asserted that. Task 0b
        changed it deliberately: ``__all__`` is what documentation tools and
        ``--no-implicit-reexport`` read, so leaving the classes out of it would have made the root
        import an undocumented accident even after ``REQ-E-006`` made it work.

        The cost is in ``test_star_import_is_the_one_eager_path`` below, asserted rather than
        hidden.
        """
        assert strands_mongodb.__all__ == ["MongoDBMemoryStore", "MongoDBStorage", "__version__"]

    def test_dir_lists_the_lazy_names_before_anything_has_imported_them(self) -> None:
        """Tab completion and ``help()`` walk ``__dir__``, which does not see ``__getattr__``.

        Run in a subprocess so nothing in this session has already resolved the names, which would
        put them in ``globals()`` and make the assertion pass without ``__dir__`` existing at all.
        """
        source = (
            "import strands_mongodb;"
            "names = dir(strands_mongodb);"
            "print('MongoDBStorage' in names, 'MongoDBMemoryStore' in names)"
        )
        result = subprocess.run([sys.executable, "-c", source], capture_output=True, text=True, check=True)

        assert result.stdout.strip() == "True True"

    def test_storage_class_lives_in_the_storage_module(self) -> None:
        """``MongoDBStorage`` is importable from ``strands_mongodb.storage``.

        This path survives the flat-layout move unchanged, because ``storage`` goes from being a
        package to being a module of the same name.
        """
        from strands_mongodb.storage import MongoDBStorage

        assert MongoDBStorage.__name__ == "MongoDBStorage"

    def test_memory_class_lives_in_the_memory_store_module(self) -> None:
        """``MongoDBMemoryStore`` is importable from ``strands_mongodb.memory_store``.

        The one import path the layout move deliberately broke. This test named
        ``strands_mongodb.memory`` against the scaffold; plan §5.4 names the module
        ``memory_store.py``, matching the extension template's own ``memory_store.py``, so Task 0b
        edited it. The edit is the record that the break was chosen rather than discovered, and
        nothing was published under the old path: 0.0.1 never built.
        """
        from strands_mongodb.memory_store import MongoDBMemoryStore

        assert MongoDBMemoryStore.__name__ == "MongoDBMemoryStore"

    def test_the_retired_module_path_is_gone(self) -> None:
        """``strands_mongodb.memory`` must not resolve, by leftover directory or by lazy alias.

        A stale ``memory/`` directory with only a ``__pycache__`` in it survives a careless move and
        still imports as a namespace package on some layouts, giving a module with no
        ``MongoDBMemoryStore`` in it. That failure reads as a broken install rather than a renamed
        module.
        """
        with pytest.raises(ImportError):
            import strands_mongodb.memory  # type: ignore[import-not-found]  # noqa: F401

    def test_version_is_a_string(self) -> None:
        """``__version__`` resolves whether or not the package is installed."""
        assert isinstance(strands_mongodb.__version__, str)
        assert strands_mongodb.__version__


class TestBareImportPullsNothing:
    """CH-004 / INV-004 — importing the package imports no driver."""

    def test_importing_the_package_does_not_import_pymongo(self) -> None:
        """``import strands_mongodb`` leaves ``pymongo`` out of ``sys.modules``.

        Runs in a subprocess because this test session has already imported ``pymongo`` through
        other tests and fixtures. Asserting on the current interpreter's ``sys.modules`` would pass
        or fail based on test ordering, which is worse than not testing it: it would look like
        coverage while measuring collection order.
        """
        source = (
            "import sys;"
            "import strands_mongodb;"
            "leaked = sorted(m for m in ('pymongo', 'pymongo_search_utils', 'strands') if m in sys.modules);"
            "print(','.join(leaked))"
        )
        result = subprocess.run(
            [sys.executable, "-c", source],
            capture_output=True,
            text=True,
            check=True,
        )
        assert result.stdout.strip() == "", (
            f"import strands_mongodb pulled in {result.stdout.strip()}. A bare install has none of "
            f"these, so the import would fail for anyone who installed no extra."
        )


class TestTheBareInstallPromise:
    """AT-001a / REQ-E-001 / INV-004 — importable with nothing installed at all.

    ``TestBareImportPullsNothing`` above runs in the development venv, where every dependency is
    present and merely goes unimported. That is a weaker claim than the one the package makes. Here
    the interpreter starts with ``-S``, so ``site-packages`` is off ``sys.path`` entirely: no
    ``pymongo``, no ``strands``, and no installed distribution metadata for the package itself.
    ``PYTHONPATH`` supplies ``src`` and nothing else.
    """

    def test_importing_from_a_source_tree_with_no_dependencies_succeeds(self) -> None:
        """The bare install works, and an uninstalled tree reports the fallback version.

        Both halves in one run because they share the one condition worth reproducing. The
        ``except PackageNotFoundError`` branch in ``__init__.py`` exists for a source tree that was
        never installed, and simulating it by patching ``importlib.metadata.version`` would test the
        patch. Here the metadata is genuinely unreachable.

        Coverage does not see this child: ``-S`` also skips the ``.pth`` file that starts
        ``coverage`` in a subprocess, so the fallback lines still report as missed. Measuring them
        would mean putting ``site-packages`` back, which is the thing under test.
        """
        source = (
            "import sys;"
            "import strands_mongodb;"
            "print(strands_mongodb.__version__);"
            "print(any('site-packages' in p for p in sys.path));"
            "print(sorted(m for m in ('pymongo', 'pymongo_search_utils', 'strands') if m in sys.modules))"
        )
        result = subprocess.run(
            [sys.executable, "-S", "-c", source],
            capture_output=True,
            text=True,
            check=True,
            env={"PYTHONPATH": str(SRC)},
        )

        assert result.stdout.splitlines() == ["0.0.0+unknown", "False", "[]"], result.stdout


class TestNamingConvention:
    """CH-005 / INV-005 — the class prefix is ``MongoDB``, not ``Mongodb``."""

    def test_both_classes_spell_the_prefix_in_full_caps(self) -> None:
        """A rename here is silent at import time and breaks every consumer.

        Checked against the string rather than by importing the names, so the assertion is about
        the spelling itself and does not pass merely because some name resolved.
        """
        from strands_mongodb.memory_store import MongoDBMemoryStore
        from strands_mongodb.storage import MongoDBStorage

        for cls in (MongoDBStorage, MongoDBMemoryStore):
            assert cls.__name__.startswith("MongoDB"), cls.__name__
            assert not cls.__name__.startswith("Mongodb"), cls.__name__
