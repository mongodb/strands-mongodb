"""Acceptance tests for the lazy top-level re-export.

Covers ``AT-006a`` through ``AT-006f`` (``REQ-E-006``) and ``AT-007a``/``AT-007b`` (``REQ-E-007``),
and stands at boundary **B-12**: a name in the package root to a module imported on first access.

Three constraints meet here and the scaffold treated them as irreconcilable, exporting nothing:

1. ``from strands_mongodb import MongoDBStorage`` should work, because that is what the extension
   template does and what a reader expects.
2. Importing the package root must pull no driver (``INV-004``), so a bare install can import it.
3. A ``[storage]``-only install must not execute the memory module, which fails on
   ``pymongo_search_utils``.

PEP 562 module-level ``__getattr__`` satisfies all three. ``AT-006d`` is the test that makes that
claim checkable rather than asserted: without its second half, an implementation that imported both
modules on first access would pass every other test in this file.
"""

from __future__ import annotations

import subprocess
import sys
import textwrap
from typing import TYPE_CHECKING

import pytest

import strands_mongodb

if TYPE_CHECKING:
    from collections.abc import Callable

LAZY_NAMES = [
    ("MongoDBStorage", "strands_mongodb.storage"),
    ("MongoDBMemoryStore", "strands_mongodb.memory_store"),
]


class TestLazyNamesResolveFromThePackageRoot:
    """AT-006a / AT-006b — the convenience import works."""

    @pytest.mark.parametrize(("name", "module"), LAZY_NAMES)
    def test_root_attribute_is_the_same_object_as_the_module_attribute(self, name: str, module: str) -> None:
        """Identity, not name equality.

        A ``__getattr__`` that built a placeholder, returned a subclass, or re-executed the module
        on every access would satisfy a ``__name__`` check while handing callers an object that
        fails ``isinstance``. ``is`` is the assertion that the two paths reach one class.
        """
        from importlib import import_module

        assert getattr(strands_mongodb, name) is getattr(import_module(module), name)

    @pytest.mark.parametrize(("name", "module"), LAZY_NAMES)
    def test_the_resolved_class_reports_its_defining_module(self, name: str, module: str) -> None:
        """``__module__`` names the backend module, so tracebacks and docs point at the real home.

        The lazy root is a convenience. It must not make the class look like it lives in
        ``strands_mongodb`` itself, because the extras story depends on readers knowing which
        module, and therefore which extra, a name belongs to.
        """
        assert getattr(strands_mongodb, name).__module__ == module


class TestUnknownNamesRaiseAttributeError:
    """AT-006c — the failure mode of a dict lookup, corrected."""

    def test_unknown_attribute_raises_attribute_error_naming_module_and_attribute(self) -> None:
        """``KeyError`` here would be wrong twice over.

        It reads as an internal defect rather than a typo, and it breaks the protocol every
        introspection tool relies on. ``pytest.raises(AttributeError)`` is itself half the
        assertion: a ``KeyError`` escapes it.
        """
        with pytest.raises(AttributeError) as caught:
            _ = strands_mongodb.NoSuchName  # type: ignore[attr-defined]

        message = str(caught.value)
        assert "strands_mongodb" in message
        assert "NoSuchName" in message

    @pytest.mark.parametrize(
        "probe",
        [
            "__wrapped__",
            "__bases__",
            "__deepcopy__",
            "_ipython_canary_method_should_not_exist_",
        ],
    )
    def test_hasattr_returns_false_for_the_names_tooling_probes(self, probe: str) -> None:
        """The concrete reason ``AttributeError`` is not a style preference.

        ``inspect``, ``copy``, ``pickle``, doctest collection and IPython display all probe modules
        for dunder attributes with ``hasattr``. ``hasattr`` converts ``AttributeError`` to ``False``
        and lets everything else propagate, so a ``KeyError`` from the lazy table would surface as
        an unrelated crash inside pytest collection or a REPL, far from its cause.
        """
        assert hasattr(strands_mongodb, probe) is False


class TestAccessImportsOnlyWhatWasAsked:
    """AT-006d / INV-004 — the load-bearing test."""

    def test_importing_the_root_then_touching_storage_leaves_the_memory_dependency_alone(self) -> None:
        """Two phases in one subprocess, because the transition is what matters.

        Phase one repeats ``INV-004``: a bare ``import strands_mongodb`` loads no driver. Phase two
        is the part no other test covers: resolving ``MongoDBStorage`` must import ``pymongo`` and
        must **not** import ``pymongo_search_utils``. An implementation that eagerly walked the lazy
        table, or imported a shared module that pulled both, would pass phase one and fail here.

        A subprocess is required: this session has already imported both packages through other
        tests, so ``sys.modules`` in-process would report collection order rather than behavior.
        """
        source = """
            import sys

            import strands_mongodb


            def loaded() -> str:
                return ",".join(m for m in ("pymongo", "pymongo_search_utils") if m in sys.modules)


            print("after-import:" + loaded())
            _ = strands_mongodb.MongoDBStorage
            print("after-storage:" + loaded())
            """
        result = subprocess.run(
            [sys.executable, "-c", textwrap.dedent(source)],
            capture_output=True,
            text=True,
            check=True,
        )

        assert result.stdout.splitlines() == ["after-import:", "after-storage:pymongo"], result.stdout

    def test_touching_the_memory_name_imports_the_search_dependency(self) -> None:
        """The complement, so the test above cannot pass by importing nothing at all.

        Without this, an implementation that returned a stub for every name would satisfy both
        halves of ``AT-006d``. This pins that the memory path does reach its own dependency.
        """
        source = """
            import sys

            import strands_mongodb

            _ = strands_mongodb.MongoDBMemoryStore
            print("pymongo_search_utils" in sys.modules)
            """
        result = subprocess.run(
            [sys.executable, "-c", textwrap.dedent(source)],
            capture_output=True,
            text=True,
            check=True,
        )

        assert result.stdout.strip() == "True"


class TestAMissingExtraSurfacesAsAnImportErrorNotAMissingName:
    """The failure a partial install actually produces, through the lazy path."""

    def test_the_actionable_message_survives_the_getattr_hook(self) -> None:
        """A missing extra must not be reported as a missing attribute.

        ``__getattr__`` is where an ``ImportError`` could plausibly get converted into
        ``AttributeError``, either by a defensive ``try``/``except`` or by someone making
        ``hasattr`` behave. Doing that would tell a ``[storage]``-only user that
        ``MongoDBMemoryStore`` does not exist, when the truth is that they have not installed it.

        The consequence, stated plainly: ``hasattr(strands_mongodb, "MongoDBMemoryStore")`` raises
        rather than returning ``False`` on a partial install. That is the right trade here. Silent
        ``False`` is how feature-detection code takes a wrong branch and reports the wrong reason.
        """
        source = """
            import sys


            class Blocker:
                def find_spec(self, fullname, path=None, target=None):
                    if fullname == "pymongo_search_utils":
                        raise ImportError("No module named 'pymongo_search_utils'", name=fullname)
                    return None


            sys.meta_path.insert(0, Blocker())

            import strands_mongodb

            try:
                strands_mongodb.MongoDBMemoryStore
            except ImportError as error:
                print(type(error).__name__)
                print(str(error).splitlines()[0])
            except AttributeError as error:
                print("WRONG EXCEPTION TYPE: AttributeError")
            """
        result = subprocess.run(
            [sys.executable, "-c", textwrap.dedent(source)],
            capture_output=True,
            text=True,
            check=True,
        )

        assert result.stdout.splitlines() == [
            "ImportError",
            "strands_mongodb.memory_store requires the 'memory' extra, which is not installed.",
        ], result.stdout


class TestStarImportIsTheOneEagerPath:
    """The cost of naming the lazy classes in ``__all__``, pinned rather than discovered later."""

    def test_star_import_resolves_both_backends(self) -> None:
        """``from strands_mongodb import *`` walks ``__all__``, so it imports both modules.

        This is the trade taken when the classes were added to ``__all__``: doc tooling and
        ``--no-implicit-reexport`` see the real public surface, and in exchange a star import on a
        ``[storage]``-only install fails. It fails with the ``missing_extra`` message naming the
        ``memory`` extra, which is wrong advice for someone who deliberately installed one surface.

        Bare ``import strands_mongodb`` is the path that must stay clean, and
        ``test_importing_the_root_then_touching_storage_leaves_the_memory_dependency_alone`` is what
        holds it. Star importing a library root is not a pattern this package optimises for.
        """
        source = """
            import sys

            from strands_mongodb import *  # noqa: F403

            print(",".join(m for m in ("pymongo", "pymongo_search_utils") if m in sys.modules))
            """
        result = subprocess.run(
            [sys.executable, "-c", textwrap.dedent(source)],
            capture_output=True,
            text=True,
            check=True,
        )

        assert result.stdout.strip() == "pymongo,pymongo_search_utils"


class TestTypeCheckersSeeTheRealClasses:
    """AT-007a / AT-007b / REQ-E-007 — what the ``TYPE_CHECKING`` block buys."""

    @pytest.mark.parametrize(("name", "module"), LAZY_NAMES)
    def test_revealed_type_is_the_class_not_any(
        self, run_mypy: Callable[[str], subprocess.CompletedProcess[str]], name: str, module: str
    ) -> None:
        """Without the ``TYPE_CHECKING`` declarations, mypy types both names ``Any``.

        ``Any`` is worse than an error. Every downstream misuse of a lazily exported class would
        silently type check, so the convenience import would come at the cost of type safety for
        anyone who used it, and nothing would report that trade.
        """
        result = run_mypy(
            f"""
            from strands_mongodb import {name}

            reveal_type({name})
            """
        )

        assert result.returncode == 0, result.stdout
        assert f"{module}.{name}" in result.stdout, result.stdout
        assert 'Revealed type is "Any"' not in result.stdout, result.stdout

    def test_a_misspelled_lazy_name_is_object_so_misuse_fails_at_the_use_site(
        self, run_mypy: Callable[[str], subprocess.CompletedProcess[str]]
    ) -> None:
        """The cost of PEP 562, bounded and recorded rather than papered over.

        A module-level ``__getattr__`` makes mypy accept **any** attribute on the module, typed as
        the hook's return type. So the access itself does not error, and this test asserts that
        honestly instead of pretending otherwise.

        What it does buy: the hook returns ``object``, not ``Any``, so the first real use of a
        typo is rejected. Declaring ``-> Any`` would make the whole file below type check clean,
        which is why the annotation is part of the requirement and not an implementation detail.
        """
        result = run_mypy(
            """
            import strands_mongodb

            strands_mongodb.MongoDBStorge()
            """
        )

        assert result.returncode == 1, result.stdout
        assert '"object" not callable' in result.stdout, result.stdout
