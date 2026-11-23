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
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from bson import ObjectId, json_util

from strands.storage.search.keyword import tokenize
from strands.storage.storage import _normalize_key, _normalize_prefix

from strands_mongodb import MongoDBMemoryStore, MongoDBStorage
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


CONTENT_HASHES = ["", "the user prefers dark mode", "ké 日本語 \U0001f600", "tab\tnew\nline"]

# One case per optional field of the inserted document, so a missing, extra or retyped field fails one case.
MEMORY_ADDS: list[dict[str, Any]] = [
    {"name": "plain", "scope": "tenant-a", "content": "the user prefers dark mode"},
    {"name": "unscoped", "content": "a fact from a store nobody scoped"},
    {
        "name": "metadata",
        "scope": "tenant-a",
        "content": "the user works in emea",
        "metadata": {"source": "chat", "scope": "tenant-b", "n": 1, "ratio": 0.5, "nested": {"a": [1, "b"]}},
    },
    {"name": "ttl 0", "scope": "tenant-a", "content": "forget me", "ttlSeconds": 0},
    {"name": "ttl 60", "scope": "tenant-a", "content": "forget me later", "ttlSeconds": 60},
    {"name": "embedder", "scope": "tenant-a", "content": "dark mode dark", "embedder": True},
]


class _WordEmbedder:
    """Four dimensions over ``dark``, ``mode``, ``coffee`` and ``tea``: the test suites' bag-of-words embedder."""

    async def embed(self, text: str) -> list[float]:
        words = text.lower().split()
        return [0.01 + words.count(word) for word in ("dark", "mode", "coffee", "tea")]


class _RecordingCollection:
    """Records the one ``update_one`` an ``add`` makes and reports an insert."""

    def __init__(self) -> None:
        self.calls: list[tuple[dict[str, Any], dict[str, Any]]] = []

    async def update_one(self, selector: dict[str, Any], update: dict[str, Any], upsert: bool) -> Any:
        assert upsert
        self.calls.append((selector, update))
        return SimpleNamespace(upserted_id=ObjectId("0123456789abcdef01234567"))


def canonical(value: Any) -> Any:
    """``value`` as canonical extended JSON, which names every BSON type: a double is not an int here."""
    return json.loads(json_util.dumps(value, json_options=json_util.CANONICAL_JSON_OPTIONS))


async def memory_adds() -> list[dict[str, Any]]:
    """The upsert each ``add`` sends, through the real ``add``, with the clock-dependent fields reduced."""
    cases = []
    for case in MEMORY_ADDS:
        config: dict[str, Any] = {"database": "agents", "connection_string": "mongodb://localhost:27017"}
        options: dict[str, Any] = {"name": "facts", "writable": True, "config": config}
        if "scope" in case:
            options["scope"] = case["scope"]
        if "ttlSeconds" in case:
            options["ttl_seconds"] = case["ttlSeconds"]
        if case.get("embedder"):
            config.update(embedding_dimensions=4, similarity="cosine")
            options["embedder"] = _WordEmbedder()
        store = MongoDBMemoryStore(**options)
        recorder = _RecordingCollection()

        async def initialized() -> None:
            return None

        store.initialize = initialized  # type: ignore[method-assign]
        store._collection = lambda recorder=recorder: recorder  # type: ignore[method-assign]
        await store.add(case["content"], metadata=case.get("metadata"))
        await store.close()
        [(selector, update)] = recorder.calls
        [operator] = update
        inserted = dict(update[operator])
        created_at = inserted.pop("created_at")
        expires_at = inserted.pop("expires_at", None)
        cases.append(
            {
                **case,
                "selector": canonical(selector),
                "operator": operator,
                "keys": list(update[operator]),
                "inserted": canonical(inserted),
                "createdAt": next(iter(canonical(created_at))),
                "expiresAfterMs": None
                if expires_at is None
                else round((expires_at - created_at).total_seconds() * 1000),
            }
        )
    return cases


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
        "contentHash": [
            {"input": text, "value": hashlib.sha256(text.encode("utf-8")).hexdigest()} for text in CONTENT_HASHES
        ],
        "memoryAdd": asyncio.run(memory_adds()),
    }
    OUTPUT.parent.mkdir(exist_ok=True)
    OUTPUT.write_text(json.dumps(golden, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
