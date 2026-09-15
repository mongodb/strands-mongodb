"""Characterization tests for ``_extras.missing_extra``.

Covers ``CH-003`` (``INV-003``) and ``AT-008a``/``AT-008b`` (``REQ-E-008``). The message is the whole
feature: a bare ``ModuleNotFoundError: No module named 'pymongo'`` tells a user nothing about extras,
so the value here is entirely in what the string says and what it chains from.

The ``module`` argument arrived with Task 0b. The scaffold derived the module path from the extra
name, which held only while ``strands_mongodb.memory`` was the import path. Once the module became
``memory_store.py``, that derivation started printing a path no install provides, so the caller now
passes its own ``__name__``. The characterization tests below were updated with the signature, and
that is the record of a contract changed on purpose.
"""

from __future__ import annotations

import subprocess
import sys
import textwrap

import pytest

from strands_mongodb._extras import missing_extra

# Blocks one distribution at the import-system level, so the surface module fails exactly the way it
# would for someone who installed the wrong extra. Uninstalling the package to test this would be
# the only alternative, and it would leave the venv broken for every test after it.
_IMPORT_WITH_DEPENDENCY_BLOCKED = """
import sys


class Blocker:
    def __init__(self, blocked):
        self.blocked = blocked

    def find_spec(self, fullname, path=None, target=None):
        if fullname == self.blocked or fullname.startswith(self.blocked + "."):
            raise ImportError(f"No module named {{fullname!r}}", name=fullname)
        return None


sys.meta_path.insert(0, Blocker({blocked!r}))

try:
    import {module}
except ImportError as error:
    print(error)
else:
    print("NO ERROR RAISED")
"""


class TestMissingExtra:
    """CH-003 / INV-003 — the actionable import error."""

    def test_raises_import_error_naming_the_pip_command(self) -> None:
        """The message contains the exact command that fixes the failure.

        Asserted as a substring of the literal command, quotes included. The quotes are load
        bearing: ``pip install strands-mongodb[storage]`` fails in zsh and fish before pip runs, and
        zsh is the default macOS shell.
        """
        original = ImportError("No module named 'pymongo'", name="pymongo")

        with pytest.raises(ImportError) as caught:
            missing_extra("storage", original, module="strands_mongodb.storage")

        assert "pip install 'strands-mongodb[storage]'" in str(caught.value)

    def test_chains_the_original_error(self) -> None:
        """``__cause__`` is the original failure, so the traceback keeps the missing module name."""
        original = ImportError("No module named 'pymongo'", name="pymongo")

        with pytest.raises(ImportError) as caught:
            missing_extra("storage", original, module="strands_mongodb.storage")

        assert caught.value.__cause__ is original

    def test_names_the_missing_module(self) -> None:
        """The message says which module was absent, not only which extra to install."""
        original = ImportError("No module named 'pymongo_search_utils'", name="pymongo_search_utils")

        with pytest.raises(ImportError) as caught:
            missing_extra("memory", original, module="strands_mongodb.memory_store")

        assert "pymongo_search_utils" in str(caught.value)

    def test_offers_the_all_extra_as_the_alternative(self) -> None:
        """A user who wants both surfaces is told so here rather than by trial and error."""
        with pytest.raises(ImportError) as caught:
            missing_extra("memory", ImportError("boom", name="pymongo"), module="strands_mongodb.memory_store")

        assert "pip install 'strands-mongodb[all]'" in str(caught.value)

    @pytest.mark.parametrize(
        ("extra", "module"),
        [("storage", "strands_mongodb.storage"), ("memory", "strands_mongodb.memory_store")],
    )
    def test_message_names_both_the_extra_and_the_module(self, extra: str, module: str) -> None:
        """Both are interpolated, not hardcoded per call site, and they are no longer the same word."""
        with pytest.raises(ImportError) as caught:
            missing_extra(extra, ImportError("boom", name="pymongo"), module=module)

        assert f"{module} requires" in str(caught.value)
        assert f"[{extra}]" in str(caught.value)

    def test_error_with_no_name_attribute_still_produces_a_message(self) -> None:
        """A plain ``ImportError`` carries ``name is None``, and the fallback must not print ``None``.

        ``missing_extra`` reads ``error.name or error``. Worth pinning, because an ``ImportError``
        raised by a failing ``from x import y`` on a module that exists has ``name`` set to the
        module while the interesting part is the attribute, and a bare ``raise ImportError("...")``
        has no ``name`` at all.
        """
        with pytest.raises(ImportError) as caught:
            missing_extra("storage", ImportError("cannot import name 'Storage'"), module="strands_mongodb.storage")

        message = str(caught.value)
        assert "Missing module: None" not in message
        assert "cannot import name 'Storage'" in message


class TestMessageNamesAModulePeopleCanActuallyImport:
    """AT-008a / REQ-E-008 — the module path stopped being derivable from the extra name."""

    def test_the_retired_import_path_is_not_advertised(self) -> None:
        """``strands_mongodb.memory`` must not appear, because nothing installs it any more.

        The scaffold built the message as ``strands_mongodb.{extra}``. Reading it after the layout
        move, a user would run ``pip install 'strands-mongodb[memory]'``, succeed, retry
        ``import strands_mongodb.memory``, and hit a second ``ModuleNotFoundError`` from the message
        that was supposed to unblock them.
        """
        with pytest.raises(ImportError) as caught:
            missing_extra(
                "memory",
                ImportError("boom", name="pymongo_search_utils"),
                module="strands_mongodb.memory_store",
            )

        message = str(caught.value)
        assert "strands_mongodb.memory_store requires" in message
        assert "strands_mongodb.memory requires" not in message


class TestARealFailedImportProducesTheActionableMessage:
    """AT-008b / INV-003 — end to end, through the import system.

    Every other test in this file calls ``missing_extra`` directly, which leaves the wiring
    untested: a surface module that forgot the ``try``/``except``, caught the wrong exception type,
    or passed a stale module string would pass all of them. These three run the real import with one
    dependency made unimportable, which is the situation the feature exists for.

    ``types.py`` and ``_client.py`` are the odd ones out and belong here anyway. Neither is a surface a
    user imports, and both guard a dependency **both** extras supply, so no install reaches these
    branches by choosing the wrong extra. The reachable case is a bare ``pip install strands-mongodb``,
    and the message names the ``storage`` extra plus the ``[all]`` line, which is correct advice for
    someone who installed no extra at all.

    ``_client.py`` is here for a second reason. Its guard carries a ``pragma: no cover`` pointing at
    this test, and a pragma is a claim: it says the branch is covered elsewhere rather than untested. If
    that pointer were wrong, the per-module coverage floor would read the file as fully covered while
    the branch had never run.
    """

    @pytest.mark.parametrize(
        ("module", "blocked", "extra"),
        [
            ("strands_mongodb.storage", "pymongo", "storage"),
            ("strands_mongodb.memory_store", "pymongo_search_utils", "memory"),
            ("strands_mongodb.types", "strands", "storage"),
            ("strands_mongodb._client", "pymongo", "storage"),
        ],
    )
    def test_importing_the_surface_without_its_dependency_names_the_extra(
        self, module: str, blocked: str, extra: str
    ) -> None:
        """The message names the module, the extra, the pip command and the missing dependency."""
        result = subprocess.run(
            [
                sys.executable,
                "-c",
                textwrap.dedent(_IMPORT_WITH_DEPENDENCY_BLOCKED).format(blocked=blocked, module=module),
            ],
            capture_output=True,
            text=True,
            check=True,
        )

        message = result.stdout
        assert f"{module} requires the '{extra}' extra" in message, message
        assert f"pip install 'strands-mongodb[{extra}]'" in message, message
        assert blocked in message, message
