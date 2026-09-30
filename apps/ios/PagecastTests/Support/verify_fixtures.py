#!/usr/bin/env python3
"""
Cross-language contract check for the iOS client.

The Swift model in Pagecast/Models is written by hand rather than generated,
so the wire format is the only thing holding it and packages/core together.
PagecastTests/ModelDecodingTests.swift asserts a set of invariants about real
server payloads -- but running it needs Xcode.

This script asserts the same invariants on the same fixtures, so the contract
is checked on every CI run whether or not a Mac is in the loop. If this fails,
either the server changed shape or the fixtures are stale; regenerate them with
Support/capture_fixtures.sh and look at what moved.

Usage: python3 verify_fixtures.py [fixtures-dir]
"""

from __future__ import annotations

import bisect
import json
import sys
from pathlib import Path


class Failures(list):
    def check(self, condition: bool, message: str) -> None:
        if not condition:
            self.append(message)


def main(directory: Path) -> int:
    document = json.loads((directory / "document.json").read_text())
    timeline = json.loads((directory / "timeline.json").read_text())

    content = document["content"]
    blocks, sentences = content["blocks"], content["sentences"]
    fails = Failures()

    # Token offsets are UTF-16 code-unit indices, matching JavaScript string
    # semantics. Swift's String.Index(utf16Offset:in:) reads them the same way;
    # index(_:offsetBy:) would not, and would drift after any non-ASCII text.
    for block in blocks:
        units = block["text"].encode("utf-16-le")
        for token in block["tokens"]:
            actual = units[token["start"] * 2 : token["end"] * 2].decode("utf-16-le")
            fails.check(
                actual == token["text"],
                f"block {block['index']} token {token['i']}: {actual!r} != {token['text']!r}",
            )

    # Tokens plus the gaps between them must reproduce the paragraph exactly,
    # or the rendered text loses punctuation.
    for block in blocks:
        units = block["text"].encode("utf-16-le")
        tokens = block["tokens"]
        rebuilt = ""
        if tokens and tokens[0]["start"] > 0:
            rebuilt += units[: tokens[0]["start"] * 2].decode("utf-16-le")
        for i, token in enumerate(tokens):
            rebuilt += token["text"]
            following = tokens[i + 1]["start"] if i + 1 < len(tokens) else len(units) // 2
            rebuilt += units[token["end"] * 2 : following * 2].decode("utf-16-le")
        fails.check(rebuilt == block["text"], f"block {block['index']} did not round-trip")

    # Sentences must tile every block with no gaps and no overlaps, or the
    # sentence tint will leave holes.
    covered: dict[int, int] = {}
    for sentence in sentences:
        fails.check(sentence["endToken"] > sentence["startToken"], f"empty sentence {sentence['index']}")
        fails.check(
            covered.get(sentence["blockIndex"], 0) == sentence["startToken"],
            f"gap in block {sentence['blockIndex']} before sentence {sentence['index']}",
        )
        covered[sentence["blockIndex"]] = sentence["endToken"]
    for block in blocks:
        fails.check(
            covered.get(block["index"]) == len(block["tokens"]),
            f"block {block['index']} is not fully covered by sentences",
        )

    # Position and time must round-trip through the same binary searches
    # TimelineIndex performs.
    words = timeline["words"]
    starts = [w["startMs"] for w in words]
    keys = [(w["blockIndex"], w["tokenIndex"]) for w in words]

    def word_index_at(ms: int) -> int:
        return 0 if ms <= starts[0] else bisect.bisect_right(starts, ms) - 1

    def time_at(position: tuple[int, int]) -> int:
        i = bisect.bisect_left(keys, position)
        return timeline["durationMs"] if i >= len(words) else words[i]["startMs"]

    for word in words:
        position = (word["blockIndex"], word["tokenIndex"])
        fails.check(time_at(position) == word["startMs"], f"timeMs{position} is wrong")
        fails.check(keys[word_index_at(word["startMs"])] == position, f"positionAt({word['startMs']}) is wrong")

    fails.check(word_index_at(-10_000) == 0, "a negative time should clamp to the first word")
    fails.check(word_index_at(9_999_999) == len(words) - 1, "a huge time should clamp to the last word")

    # The tinted sentence must always contain the pilled word, or the two
    # highlights disagree on screen.
    sentence_starts = timeline["sentenceStarts"]
    for index, word in enumerate(words):
        sentence = sentences[max(0, bisect.bisect_right(sentence_starts, index) - 1)]
        inside = (
            sentence["blockIndex"] == word["blockIndex"]
            and sentence["startToken"] <= word["tokenIndex"] < sentence["endToken"]
        )
        fails.check(inside, f"word {index} falls outside its highlighted sentence")

    # Progress must span the full 0...1, or a finished document never leaves
    # the "continue listening" shelf.
    offsets, running = [0], 0
    for block in blocks:
        running += len(block["tokens"])
        offsets.append(running)
    total = offsets[-1]

    def progress(block_index: int, token_index: int) -> float:
        return 0.0 if total <= 1 else min(1, max(0, (offsets[block_index] + token_index) / (total - 1)))

    fails.check(progress(0, 0) == 0, "progress at the first word should be 0")
    last = blocks[-1]
    end = progress(last["index"], len(last["tokens"]) - 1)
    fails.check(abs(end - 1.0) < 1e-9, f"progress at the last word is {end}, not 1")

    # The timeline must end exactly where the audio does.
    final_chunk = timeline["chunks"][-1]
    fails.check(
        timeline["durationMs"] == final_chunk["startMs"] + final_chunk["durationMs"],
        "timeline duration does not match the chunk span",
    )

    print(f"words={len(words)} blocks={len(blocks)} sentences={len(sentences)} tokens={total}")
    if fails:
        print(f"\n{len(fails)} failure(s):", file=sys.stderr)
        for failure in fails[:20]:
            print(f"  - {failure}", file=sys.stderr)
        return 1

    print("All invariants hold on the captured server payloads.")
    return 0


if __name__ == "__main__":
    base = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "Fixtures"
    raise SystemExit(main(base))
