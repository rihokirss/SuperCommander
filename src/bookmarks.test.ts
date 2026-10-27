import { describe, expect, it } from "vitest";
import { bookmarkKey, bookmarkPath, normalizeBookmarks } from "./bookmarks";
describe("persistent bookmarks", () => {
  it("unifies Windows case/separators and SSH spellings while retaining remote path case", () => {
    expect(bookmarkKey({ path: "C:/Folder/" })).toBe(
      bookmarkKey({ path: "c:\\folder" }),
    );
    expect(bookmarkKey({ path: "ssh://demo/var/www/" })).toBe(
      bookmarkKey({ path: "sftp://DEMO/var/www" }),
    );
    expect(bookmarkKey({ path: "ssh://demo/Var" })).not.toBe(
      bookmarkKey({ path: "ssh://demo/var" }),
    );
    expect(bookmarkKey({ source: "zip:C:\\one.zip", path: "/" })).not.toBe(
      bookmarkKey({ source: "zip:C:\\two.zip", path: "/" }),
    );
  });
  it("normalizes remote aliases without storing credentials and rejects ambiguous entries", () => {
    expect(bookmarkPath("demo:/var/Õunad")).toEqual({
      path: "sftp://demo/var/%C3%95unad",
    });
    for (const path of [
      "relative",
      "https://example.com/a",
      "ssh://user:secret@server/a",
      "ssh://server/line%0Abreak",
      "ssh://line%0Abreak@server/var",
      "C:\\bad\nname",
    ])
      expect(bookmarkPath(path)).toBeNull();
    expect(bookmarkPath("/../escape", "zip:C:\\one.zip")).toBeNull();
    expect(bookmarkPath("/folder", "zip:relative.zip")).toBeNull();
    expect(bookmarkPath("/folder", "zip:ssh://demo/archive.zip")).toBeNull();
    expect(bookmarkPath("/folder", "sftp:expired-session")).toBeNull();
    expect(bookmarkPath("/folder/", "zip:C:/one.zip")).toEqual({
      source: "zip:C:\\one.zip",
      path: "/folder",
    });
  });
  it("migrates old favorites and prunes malformed or duplicate settings", () => {
    expect(
      normalizeBookmarks([
        { path: "C:\\Folder", name: "First" },
        { path: "c:/folder/", name: "Duplicate" },
        null,
        { name: "Missing path" },
        { path: "ssh://a/var", name: "Server" },
      ]).map((b) => b.name),
    ).toEqual(["First", "Server"]);
    expect(normalizeBookmarks(null)).toEqual([]);
  });
});
