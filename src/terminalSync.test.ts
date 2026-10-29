import { describe, expect, it } from "vitest";
import { directoryCommand, TerminalSync } from "./terminalSync";

describe("terminal directory following", () => {
  it("waits for a shell prompt and follows the latest panel location", () => {
    const sent: string[] = [];
    const sync = new TerminalSync(true, (command) => sent.push(command), () => {});
    sync.setTarget("C:\\one");
    sync.setTarget("C:\\two");
    expect(sent).toEqual([]);
    sync.prompt("C:\\home");
    expect(sent).toEqual(["Set-Location -LiteralPath 'C:\\two'\r"]);
    sync.prompt("C:\\two");
    expect(sent).toHaveLength(1);
  });

  it("does not interrupt typed input or a running command", () => {
    const sent: string[] = [];
    const sync = new TerminalSync(false, (command) => sent.push(command), () => {});
    sync.setTarget("/old");
    sync.prompt("/old");
    sync.input("echo work");
    sync.setTarget("/new");
    sync.input("\r");
    expect(sent).toEqual([]);
    sync.prompt("/old");
    expect(sent).toEqual(["cd -- '/new'\r"]);
  });

  it("preserves type-ahead entered before the first or next prompt", () => {
    const sent: string[] = [];
    const sync = new TerminalSync(false, (command) => sent.push(command), () => {});
    sync.setTarget("/new");
    sync.input("partly typed");
    sync.prompt("/old");
    expect(sent).toEqual([]);
    sync.input("\rnext command");
    sync.prompt("/old");
    expect(sent).toEqual([]);
    sync.input("\r");
    sync.prompt("/old");
    expect(sent).toEqual(["cd -- '/new'\r"]);
  });

  it("does not retry a failing change in a loop", () => {
    const sent: string[] = [];
    const statuses: string[] = [];
    const sync = new TerminalSync(false, (command) => sent.push(command), (status) => statuses.push(status));
    sync.setTarget("/missing");
    sync.prompt("/old");
    sync.prompt("/old");
    expect(sent).toHaveLength(1);
    expect(statuses.at(-1)).toBe("failed");
  });

  it("quotes paths and refuses terminal control characters", () => {
    expect(directoryCommand("C:\\O'Brien", true)).toBe("Set-Location -LiteralPath 'C:\\O''Brien'\r");
    expect(directoryCommand("/a'b", false)).toBe("cd -- '/a'\\''b'\r");
    expect(() => directoryCommand("/a\nrm", false)).toThrow();
  });
});
