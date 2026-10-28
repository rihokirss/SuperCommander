import { describe, expect, it } from "vitest";
import { applyChoice, choicesFor, folderSelection } from "./comparison";
import type { ComparisonRow } from "./types";
function row(
  id: number,
  path: string,
  status: string,
  toLeft: boolean,
  toRight: boolean,
  dir = false,
): ComparisonRow {
  const node = {
    entry: {
      name: path,
      path,
      isDir: dir,
      isSymlink: false,
      size: 1,
      modified: 0,
      hidden: false,
    },
    relative: path,
    error: null,
    empty: dir,
  };
  return {
    id,
    path,
    status,
    toLeft,
    toRight,
    left: status === "right_only" ? null : node,
    right: status === "left_only" ? null : node,
    blocked: null,
  };
}
describe("reviewed comparison directions", () => {
  it("newer defaults leave equal-time differences and blocked/read-only destinations for explicit review", () => {
    const rows = [
      row(0, "left", "left_only", false, true),
      row(1, "right", "right_newer", true, true),
      row(2, "unknown", "different", true, true),
      row(3, "blocked", "left_newer", false, false),
    ];
    expect([...choicesFor(rows, "newer")]).toEqual([
      [0, "left_to_right"],
      [1, "right_to_left"],
    ]);
    expect([...choicesFor(rows, "left").keys()]).toEqual([0, 1, 2]);
  });
  it("folder directions affect only compared descendants and preserve unrelated choices", () => {
    const rows = [
      row(0, "Folder", "left_only", false, true, true),
      row(1, "Folder/one", "left_only", false, true),
      row(2, "Folderish/two", "left_only", false, true),
      row(3, "other", "right_only", true, false),
    ];
    const selected = applyChoice(
      rows,
      new Map([[3, "right_to_left"]]),
      rows[0],
      "left_to_right",
    );
    expect([...selected.keys()].sort()).toEqual([0, 1, 3]);
    expect([...applyChoice(rows, selected, rows[0]).keys()]).toEqual([3]);
  });
  it("case-insensitive folder grouping follows matched paths without changing the source direction", () => {
    const rows = [
      row(0, "Folder", "same", false, false, true),
      row(1, "folder/one", "right_only", true, false),
    ];
    const selected = applyChoice(
      rows,
      new Map(),
      rows[0],
      "right_to_left",
      false,
    );
    expect([...selected]).toEqual([[1, "right_to_left"]]);
    expect(folderSelection(rows, selected, false).get(0)).toMatchObject({
      total: 1,
      selected: 1,
      left: 1,
    });
  });
});
