"""Regenerate ``typescript/test/fixtures/golden.json`` from the Python package.

The TypeScript package promises to read and write the same documents as the Python one. The golden file holds
what the Python package computes for fixed inputs, and ``test/unit/golden.test.ts`` asserts the TypeScript code
computes the same. A change to Python's behaviour then shows up as a diff in a reviewed file rather than as a
silent split between the two packages.

Run by hand, never in CI, from ``python/`` so Hatch supplies an environment with the package installed::

    hatch run python -I ../typescript/scripts/golden.py

Each milestone of the TypeScript port adds the sections its code needs: key handling and the tokenizer now,
the search pipelines with milestone 8, and the document shapes and ``content_hash`` with the memory store.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

from strands.storage.search.keyword import tokenize
from strands.storage.storage import _normalize_key, _normalize_prefix

from strands_mongodb import MongoDBStorage
from strands_mongodb._indexes import VectorMode
from strands_mongodb._pipeline import hybrid_stages, text_stages, vector_stages
from strands_mongodb.storage import _abbreviate, _encoded_size, _successor

OUTPUT = Path(__file__).resolve().parent.parent / "test" / "fixtures" / "golden.json"

KEYS = [
    "a",
    "a/b",
    "a//b",
    "/a/b/",
    "//a//b//",
    "a/./b",
    "...",
    " a / b ",
    "ké/日本語",
    "\U0001f600/x",
    "",
    "/",
    "..",
    "a/../b",
    "a\\b",
]

PREFIXES = ["", "/", "a", "a/", "a//", "//a//b//", "ké/", "..", "a/../b", "a\\b"]

INSTANCE_PREFIXES = ["", "/", "tenant-a", "tenant-a/", "/tenant-a", "tenant-a//", "a//b/", "日本/"]

RANGE_QUERIES = ["", "a", "sessions/", "//a//", "ké", "퟿", "a\U0010ffff", "\U0010ffff", "\U0001f600"]

SUCCESSORS = ["a", "session/", "ké", "퟿", "a\U0010ffff", "\U0010ffff\U0010ffff", "a\U0001f600", "￿"]

ABBREVIATIONS = ["k" * 60, "k" * 61, "k" * 1025, "\U0001f600" * 61, "é" * 70]

ENCODED_SIZES: list[tuple[str, int, bool]] = [
    ("a", 0, False),
    ("tenant-a/sessions/abc", 1000, False),
    ("ké/日本語", 17, True),
    ("\U0001f600", 3, True),
]

TOKENIZE = [
    "Dark-Mode toggle",
    "state.json",
    "dark_mode",
    "münchen café",
    "日本語",
    "v2 x²",
    "ΟΔΟΣ",
    "İstanbul",
    "Straße",
    "é",
    "tab\tnew\nline",
    "",
]


AUTO_EMBED = VectorMode(model="voyage-4")
MANUAL = VectorMode(dimensions=4, similarity="cosine")
FILTER = {"$and": [{"scope": "s"}, {"metadata.tier": "gold"}]}

# One case per stage shape, so a difference in key order or nesting shows up as a failing case.
PIPELINES: list[tuple[str, Any]] = [
    ("vector, autoEmbed", lambda: vector_stages(mode=AUTO_EMBED, index_name="v", limit=5, query_text="dark mode")),
    (
        "vector, autoEmbed, filtered",
        lambda: vector_stages(
            mode=AUTO_EMBED, index_name="v", limit=5, query_text="dark mode", query_filter=FILTER, oversampling_factor=3
        ),
    ),
    ("vector, manual", lambda: vector_stages(mode=MANUAL, index_name="v", limit=5, query_vector=[1.0, 0.5, 0.0, 0.0])),
    (
        "vector, manual, filtered, unscored",
        lambda: vector_stages(
            mode=MANUAL, index_name="v", limit=5, query_vector=[1.0, 0.5, 0.0, 0.0], query_filter=FILTER, score=False
        ),
    ),
    ("text", lambda: text_stages(query_text="dark mode", index_name="t", limit=5)),
    ("text, filtered", lambda: text_stages(query_text="dark mode", index_name="t", limit=5, query_filter=FILTER)),
    (
        "text, filtered, unscored",
        lambda: text_stages(query_text="dark mode", index_name="t", limit=5, query_filter=FILTER, score=False),
    ),
    (
        "hybrid, autoEmbed, filtered",
        lambda: hybrid_stages(
            mode=AUTO_EMBED,
            vector_index_name="v",
            text_index_name="t",
            query_text="dark mode",
            limit=5,
            query_filter=FILTER,
        ),
    ),
    (
        "hybrid, manual",
        lambda: hybrid_stages(
            mode=MANUAL,
            vector_index_name="v",
            text_index_name="t",
            query_text="dark mode",
            query_vector=[1.0, 0.5, 0.0, 0.0],
            limit=5,
            oversampling_factor=2,
        ),
    ),
]


def outcome(run: Any) -> dict[str, Any]:
    """The value ``run`` returns, or the message of the error it raises."""
    try:
        return {"value": run()}
    except Exception as error:  # noqa: BLE001 - every rejection is recorded, whatever its class.
        return {"error": str(error), "type": type(error).__name__}


def storage(prefix: str) -> MongoDBStorage:
    """A storage instance that never connects: the driver opens no connection until an operation runs."""
    return MongoDBStorage(
        {"database": "agents", "connection_string": "mongodb://localhost:27017"},
        collection="storage",
        prefix=prefix,
    )


async def ids() -> list[dict[str, Any]]:
    """The ``_id`` each instance prefix gives a fixed key, through the real ``_id_for``."""
    cases = []
    for prefix in INSTANCE_PREFIXES:
        instance = storage(prefix)
        cases.append({"prefix": prefix, "key": "/sessions//abc", "instancePrefix": instance.prefix})
        cases[-1].update(outcome(lambda instance=instance: instance._id_for("/sessions//abc")))
    long_key = storage("tenant-a")
    cases.append({"prefix": "tenant-a", "key": "k" * 1016, "instancePrefix": long_key.prefix})
    cases[-1].update(outcome(lambda: long_key._id_for("k" * 1016)))
    cases.append({"prefix": "tenant-a", "key": "k" * 1015, "instancePrefix": long_key.prefix})
    cases[-1].update(outcome(lambda: long_key._id_for("k" * 1015)))
    await long_key.close()
    return cases


async def ranges() -> list[dict[str, Any]]:
    """The ``_id`` range each query scans, unprefixed and under ``tenant-a``."""
    cases = []
    for prefix in ["", "tenant-a"]:
        instance = storage(prefix)
        for query in RANGE_QUERIES:
            cases.append({"prefix": prefix, "query": query})
            cases[-1].update(outcome(lambda instance=instance, query=query: instance._range_for(query)))
        # Every instance shares the one pool its config identifies, so one close releases it.
        await instance.close()
    return cases


def main() -> None:
    """Compute every section and write the file."""
    golden = {
        "_comment": "Generated by typescript/scripts/golden.py from the Python package. Do not edit by hand.",
        "normalizeKey": [{"input": key, **outcome(lambda key=key: _normalize_key(key))} for key in KEYS],
        "normalizePrefix": [
            {"input": prefix, **outcome(lambda prefix=prefix: _normalize_prefix(prefix))} for prefix in PREFIXES
        ],
        "idFor": asyncio.run(ids()),
        "rangeFor": asyncio.run(ranges()),
        "successor": [{"input": text, "value": _successor(text)} for text in SUCCESSORS],
        "abbreviate": [{"input": key, "value": _abbreviate(key)} for key in ABBREVIATIONS],
        "encodedSize": [
            {"id": key, "dataLength": size, "expires": expires, "value": _encoded_size(key, b"\0" * size, expires=expires)}
            for key, size, expires in ENCODED_SIZES
        ],
        "tokenize": [{"input": text, "value": sorted(tokenize(text))} for text in TOKENIZE],
        "pipelines": [{"name": name, "value": build()} for name, build in PIPELINES],
    }
    OUTPUT.parent.mkdir(exist_ok=True)
    OUTPUT.write_text(json.dumps(golden, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
