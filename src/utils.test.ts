import { describe, expect, it } from "vitest";
import { basename, parent, join, size, sortEntries } from "./utils";
import type { Entry } from "./types";
import { dictionary } from "./i18n";
describe("Windows and remote navigation", () => {
  it("preserves Windows drive roots and UNC parents", () => {
    expect(parent("C:\\Users")).toBe("C:\\");
    expect(parent("C:\\")).toBe("C:\\");
    expect(parent("\\\\server\\share\\folder")).toBe("\\\\server\\share");
    expect(parent("\\\\server\\share")).toBe("\\\\server");
    expect(parent("\\\\server")).toBe("\\\\server");
    expect(parent("/home/user")).toBe("/home");
    expect(parent("/")).toBe("/");
  });
  it("joins local and remote paths without losing the separator", () => {
    expect(join("C:\\", "file.txt")).toBe("C:\\file.txt");
    expect(join("/home/", "x")).toBe("/home/x");
    expect(basename("C:\\Users\\Alex")).toBe("Alex");
  });
});
describe("file presentation", () => {
  it("keeps folders first and naturally sorts numbered filenames", () => {
    const e = (name: string, isDir = false): Entry => ({
      name,
      isDir,
      path: name,
      size: 0,
      modified: 0,
      hidden: false,
      isSymlink: false,
    });
    expect(
      sortEntries(
        [e("file10"), e("file2"), e("z-folder", true)],
        "name",
        false,
      ).map((e) => e.name),
    ).toEqual(["z-folder", "file2", "file10"]);
  });
  it("formats empty files and larger sizes", () => {
    expect(size(0)).toBe("0 B");
    expect(size(1536)).toBe("2 KB");
    expect(size(1024 * 1024)).toBe("1.0 MB");
  });
  it("has a complete Estonian dictionary", () => {
    const en = dictionary("en"),
      et = dictionary("et");
    expect(Object.keys(et).sort()).toEqual(Object.keys(en).sort());
    expect(Object.values(et).every(Boolean)).toBe(true);
  });
});
