import { expect, it } from "vitest";
import { indentEdit } from "./editor";
it("indents selected lines without including a line starting at the selection end", () => {
  expect(indentEdit("one\ntwo\nthree", 0, 8, false)).toEqual({
    from: 0,
    to: 7,
    text: "\tone\n\ttwo",
    selectionStart: 1,
    selectionEnd: 10,
  });
});
it("unindents mixed leading whitespace and keeps a cursor inside removed indentation on its line", () => {
  expect(indentEdit("    õun\n\ttwo\nlast", 2, 12, true)).toEqual({
    from: 0,
    to: 12,
    text: "õun\ntwo",
    selectionStart: 0,
    selectionEnd: 7,
  });
  expect(indentEdit("    line", 2, 2, true).selectionStart).toBe(0);
});
it("keeps an initial empty line in the selected block", () => {
  expect(indentEdit("\ntext", 0, 0, false)).toMatchObject({
    from: 0,
    to: 0,
    text: "\t",
    selectionStart: 1,
  });
});
