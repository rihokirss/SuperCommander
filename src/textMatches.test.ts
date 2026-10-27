import { describe, expect, it } from "vitest";
import { textMatches } from "./textMatches";
describe("literal text navigation", () => {
  it("keeps source offsets after Unicode case mapping and surrogate pairs", () => {
    const text = "İ AX 🚀 ax";
    const matches = textMatches(text, "ax");
    expect(matches).toEqual([
      { start: 2, end: 4 },
      { start: 8, end: 10 },
    ]);
    expect(matches.map((match) => text.slice(match.start, match.end))).toEqual([
      "AX",
      "ax",
    ]);
    expect(textMatches("ſ S", "s")).toHaveLength(2);
  });
  it("treats metacharacters literally and bounds the result list", () => {
    expect(textMatches("[$].* and [$].*", "[$].*")).toEqual([
      { start: 0, end: 5 },
      { start: 10, end: 15 },
    ]);
    expect(textMatches("x".repeat(10001), "x")).toHaveLength(10000);
    expect(textMatches("text", "")).toEqual([]);
  });
});
