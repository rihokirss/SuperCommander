import { describe, expect, it } from "vitest";
import { matchesMask } from "./selection";
describe("file selection masks", () => {
  it("supports case-insensitive wildcards while treating other symbols literally", () => {
    expect(matchesMask("README.MD", "*.md")).toBe(true);
    expect(matchesMask("Õun.txt", "?un.txt")).toBe(true);
    expect(matchesMask("report-12.txt", "report-??.txt")).toBe(true);
    expect(matchesMask("a+b[1].txt", "a+b[1].txt")).toBe(true);
    expect(matchesMask("ab1.txt", "a+b[1].txt")).toBe(false);
    expect(matchesMask("image.png", "*.txt")).toBe(false);
    expect(matchesMask("file.txt.backup", "*.txt")).toBe(false);
  });
});
