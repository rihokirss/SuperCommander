import { expect, it } from "vitest";
import { clipboardPathKey } from "./clipboard";
it("compares Windows clipboard paths without changing case-sensitive remote paths", () => {
  expect(clipboardPathKey("C:/Folder/File.txt")).toBe(
    clipboardPathKey("c:\\folder\\file.txt"),
  );
  expect(clipboardPathKey("\\\\?\\UNC\\server\\share\\file.txt")).toBe(
    clipboardPathKey("\\\\server\\share\\FILE.TXT"),
  );
  expect(clipboardPathKey("/remote/FILE")).not.toBe(
    clipboardPathKey("/remote/file"),
  );
});
