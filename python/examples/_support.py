"""Shared scaffolding for the two examples in this directory.

Holds the scripted model, the connection lookup, the argument parser and the key-prefix census, so each
example script contains only what it demonstrates. Not part of the installed package and not an API.
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
from collections.abc import AsyncIterator, Sequence
from itertools import count
from typing import Any

from strands.models import Model
from strands.types.streaming import StopReason, StreamEvent

from strands_mongodb.types import MongoDBConfig

__all__ = [
    "URI_VARIABLE",
    "ExampleError",
    "ScriptedModel",
    "carried_options",
    "connection",
    "emit_summary",
    "model_banner",
    "mongodb_config",
    "next_command",
    "prefix_census",
    "redact",
    "resolve_model",
    "say",
    "step_parser",
]

#: The environment variable both examples read the connection string from.
URI_VARIABLE = "MONGODB_URI"

_line = count(1)


class ExampleError(RuntimeError):
    """A condition the reader can fix, reported as one line without a traceback.

    Any other exception propagates with its traceback, since it points at a bug in the example.
    """


def say(message: str) -> None:
    """Print one numbered line of output, so a transcript can be referred to by line.

    Args:
        message: One line, already worded for a reader.
    """
    print(f"{next(_line):>2}. {message}", flush=True)


def redact(uri: str) -> str:
    """Return ``uri`` with any credentials replaced.

    Args:
        uri: A MongoDB connection string.

    Returns:
        The same string with everything between ``://`` and the last ``@`` replaced by ``<redacted>``.
        The last one, because a password pasted without percent-encoding can hold ``/`` and ``@``
        itself. A URI with no ``@`` comes back unchanged.
    """
    scheme, separator, rest = uri.partition("://")
    _, at, host = rest.rpartition("@")
    if not separator or not at:
        return uri
    return f"{scheme}://<redacted>@{host}"


def connection() -> str:
    """Read the connection string, or explain what to set.

    Returns:
        The value of ``MONGODB_URI``.

    Raises:
        ExampleError: If the variable is unset or empty. The message names the variable and shows the
            shape of the value without ever printing a real one.
    """
    uri = os.environ.get(URI_VARIABLE, "")
    if not uri:
        raise ExampleError(
            f"{URI_VARIABLE} is not set. Point it at a deployment this example may write to, for "
            f"example with a shell that reads it from a file you keep out of version control:\n"
            f"    set -a; . .env; set +a\n"
            f"Pass --dry-run to see what a step would do without connecting to anything."
        )
    return uri


def model_banner(name: str) -> str:
    """Say which model runs the turn and which parts of the output it affects.

    The scripted model's replies are canned, so the banner says so. Otherwise a reader could take a
    canned reply as evidence of model behaviour.

    Args:
        name: The value of ``--model``.

    Returns:
        One line, ready to hand to :func:`say`.
    """
    if name == "scripted":
        return (
            "model: scripted. The assistant's replies come from a list in _support.py, so the turn "
            "costs nothing and reads the same on every run. Only the model is scripted: when a step runs, its "
            "MongoDB calls are real. Pass "
            "--model bedrock to run the same script against the SDK's default provider."
        )
    return (
        f"model: {name}. Replies come from the provider, so the wording below will differ from run to "
        f"run and the turn costs whatever the provider charges. Pass --model scripted to remove that."
    )


def mongodb_config(uri: str, database: str) -> MongoDBConfig:
    """Build a ``MongoDBConfig`` from a connection string.

    Passing a connection string rather than a client leaves the client's lifecycle to the package.
    The return type lets a type checker catch a misspelled key.

    Args:
        uri: A MongoDB connection string.
        database: Database to use.

    Returns:
        A mapping accepted as the ``config`` of either surface.
    """
    return {"connection_string": uri, "database": database}


def step_parser(description: str, steps: Sequence[str]) -> argparse.ArgumentParser:
    """Build the parser both examples share.

    Every default is a fixed string, not a generated one, so the next-step command one run prints still
    points at the same data when the reader runs it.

    Args:
        description: Shown by ``--help``.
        steps: Step names, in the order they are meant to be run.

    Returns:
        A parser carrying the step argument and the flags common to both examples.
    """
    parser = argparse.ArgumentParser(description=description, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("step", choices=list(steps), help="which step to run")
    parser.add_argument("--model", choices=("scripted", "bedrock"), default="scripted", help="model to run the turn")
    parser.add_argument("--database", default="strands_examples", help="database to read and write")
    parser.add_argument("--collection", default="example", help="collection to read and write")
    parser.add_argument(
        "--dry-run", action="store_true", help="describe the step and the next command, connect to nothing"
    )
    parser.add_argument("--summary-json", action="store_true", help="print one machine-readable line at the end")
    return parser


def next_command(script: str, step: str, options: Sequence[tuple[str, str]]) -> str:
    """Build the verbatim command for the next step.

    Args:
        script: File name of the running example.
        step: The step to run next.
        options: Flag and value pairs to carry over, already filtered to the ones that differ from
            their defaults. A dropped flag would send the next step to a namespace the previous
            step never wrote to.

    Returns:
        A command line, quoted so it survives a copy into a shell.
    """
    parts = ["python", f"examples/{script}", step]
    for flag, value in options:
        parts += [flag, shlex.quote(value)]
    return " ".join(parts)


def carried_options(
    parser: argparse.ArgumentParser, parsed: argparse.Namespace, names: Sequence[str]
) -> list[tuple[str, str]]:
    """Return the options to repeat in the next command, leaving out any that hold their default.

    Args:
        parser: The parser that produced ``parsed``, read for its defaults.
        parsed: The parsed arguments.
        names: Destination names to consider, in the order they should appear.

    Returns:
        Flag and value pairs, defaults omitted.
    """
    options: list[tuple[str, str]] = []
    for name in names:
        value = getattr(parsed, name)
        if value != parser.get_default(name):
            options.append((f"--{name.replace('_', '-')}", str(value)))
    return options


def emit_summary(payload: dict[str, Any], *, enabled: bool) -> None:
    """Print one line of JSON when ``--summary-json`` was passed.

    The tests read this line instead of parsing the prose, so the prose can change freely.

    Args:
        payload: Anything JSON-serializable.
        enabled: Whether ``--summary-json`` was passed.
    """
    if enabled:
        print(json.dumps(payload), flush=True)


async def prefix_census(collection: Any) -> list[dict[str, Any]]:
    """Count documents and bytes per top-level key prefix, as read from the collection.

    The prefixes belong to the SDK (``session/`` from ``SnapshotSessionManager``, ``context/`` from the
    context manager's stash, ``memory/`` from ``FileMemoryStore``), so they are discovered, not hard-coded.

    Args:
        collection: An ``AsyncCollection`` holding storage documents.

    Returns:
        One entry per prefix, sorted by prefix, each with ``prefix``, ``documents`` and ``bytes``.
        A key with no ``/`` is its own prefix, reported with a ``/`` appended.
    """
    pipeline: list[dict[str, Any]] = [
        {
            "$project": {
                "prefix": {"$arrayElemAt": [{"$split": [{"$toString": "$_id"}, "/"]}, 0]},
                "size": {"$bsonSize": "$$ROOT"},
            }
        },
        {"$group": {"_id": "$prefix", "documents": {"$sum": 1}, "bytes": {"$sum": "$size"}}},
        {"$sort": {"_id": 1}},
    ]
    census = []
    async for group in await collection.aggregate(pipeline):
        census.append({"prefix": f"{group['_id']}/", "documents": group["documents"], "bytes": group["bytes"]})
    return census


class ScriptedModel(Model):
    """A ``Model`` that reads its replies from a list instead of calling a provider.

    The examples need a model only to produce a turn, so the extraction trigger and the context manager
    have something to fire on. A scripted reply does that at no cost and needs no
    provider credentials. Pass ``--model bedrock`` to use a real model.

    The event sequence matches the SDK's mocked provider: ``messageStart``, then ``contentBlockStart``,
    ``contentBlockDelta`` and ``contentBlockStop`` per content block, then ``messageStop`` with the stop
    reason. A ``toolUse`` block sets the reason to ``tool_use``, which makes the event loop run the tool
    and ask for another reply.
    """

    def __init__(self, replies: Sequence[dict[str, Any]]) -> None:
        """Script the replies this model will give, in order.

        Args:
            replies: Assistant messages, each ``{"role": "assistant", "content": [...]}``. A block
                carrying ``text`` streams as text; a block carrying ``toolUse`` streams as a tool call.
        """
        self._replies = list(replies)
        self._index = 0

    def update_config(self, **model_config: Any) -> None:
        """Accept and ignore configuration; there is none."""

    def get_config(self) -> dict[str, Any]:
        """Return an empty configuration.

        Returns:
            An empty mapping, which is what makes ``Model.context_window_limit`` resolve to ``None``.
        """
        return {}

    async def structured_output(self, output_model: Any, prompt: Any, system_prompt: str | None = None, **kwargs: Any):
        """Refuse, since a scripted model has no structured output.

        Args:
            output_model: Ignored.
            prompt: Ignored.
            system_prompt: Ignored.
            **kwargs: Ignored.

        Raises:
            NotImplementedError: Always. Raising is clearer than returning ``None``.
        """
        raise NotImplementedError("ScriptedModel has no structured output; pass --model bedrock")
        yield {}  # pragma: no cover - unreachable, present so the method is an async generator

    async def stream(self, *args: Any, **kwargs: Any) -> AsyncIterator[StreamEvent]:
        """Stream the next scripted reply as ``StreamEvent`` dictionaries.

        Every argument is ignored, including the messages, so the output depends only on MongoDB.
        The ``StreamEvent`` annotation lets mypy check each yielded event; a misspelled key would
        otherwise stream as a silent no-op.

        Yields:
            One reply's worth of stream events.

        Raises:
            RuntimeError: If the script has run out of replies. An empty stream would read as a reply
                with no content.
        """
        if self._index >= len(self._replies):
            raise RuntimeError(
                f"ScriptedModel ran out of replies after {len(self._replies)}; the turn asked for another"
            )
        reply = self._replies[self._index]
        self._index += 1

        yield {"messageStart": {"role": "assistant"}}
        stop_reason: StopReason = "end_turn"
        for block in reply["content"]:
            if "text" in block:
                yield {"contentBlockStart": {"start": {}}}
                yield {"contentBlockDelta": {"delta": {"text": block["text"]}}}
                yield {"contentBlockStop": {}}
            if "toolUse" in block:
                stop_reason = "tool_use"
                tool_use = block["toolUse"]
                yield {
                    "contentBlockStart": {
                        "start": {"toolUse": {"name": tool_use["name"], "toolUseId": tool_use["toolUseId"]}}
                    }
                }
                yield {"contentBlockDelta": {"delta": {"toolUse": {"input": json.dumps(tool_use["input"])}}}}
                yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": stop_reason}}


def resolve_model(name: str, replies: Sequence[dict[str, Any]]) -> Model:
    """Return the model the ``--model`` flag asked for.

    Args:
        name: ``scripted`` or ``bedrock``.
        replies: The script, used only by ``scripted``.

    Returns:
        A ``Model``. The Bedrock branch takes no arguments, so it uses whatever region and credentials
        the environment already provides and whichever model id the SDK defaults to.

    Raises:
        ExampleError: If ``name`` is neither of those.
    """
    if name == "scripted":
        return ScriptedModel(replies)
    if name == "bedrock":
        from strands.models import BedrockModel

        return BedrockModel()
    raise ExampleError(f"unknown model {name!r}")
