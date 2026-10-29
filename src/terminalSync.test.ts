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

  it("accepts the shell's successful change when Windows reports a long-name alias", () => {
    const sent: string[] = [];
    const statuses: string[] = [];
    const sync = new TerminalSync(true, (command) => sent.push(command), (status) => statuses.push(status), "1234567890abcdef1234567890abcdef");
    sync.setTarget("C:\\Users\\RUNNER~1\\project");
    sync.prompt("C:\\Users\\runneradmin\\project");
    expect(sent).toHaveLength(1);
    sync.acknowledge();
    sync.prompt("C:\\Users\\runneradmin\\project");
    expect(statuses.at(-1)).toBe("synced");
    sync.prompt("C:\\Users\\runneradmin\\project");
    expect(sent).toHaveLength(1);
  });

  it("quotes paths and refuses terminal control characters", () => {
    expect(directoryCommand("C:\\O'Brien", true)).toBe("Set-Location -LiteralPath 'C:\\O''Brien'\r");
    expect(directoryCommand("/a'b", false)).toBe("cd -- '/a'\\''b'\r");
    expect(() => directoryCommand("/a\nrm", false)).toThrow();
  });

  it("adopts a manual shell directory change without sending it back", () => {
    const sent: string[] = [], changed: string[] = [];
    const sync = new TerminalSync(false, (data) => sent.push(data), () => {}, undefined, (cwd) => changed.push(cwd));
    sync.setTarget("/old");
    sync.prompt("/old");
    sync.input("cd /new\r");
    sync.prompt("/new");
    expect(changed).toEqual(["/new"]);
    sync.setTarget("/new");
    sync.prompt("/new");
    expect(sent).toEqual([]);
  });

  it("keeps a pane navigation requested while a shell command was running", () => {
    const sent: string[] = [], changed: string[] = [];
    const sync = new TerminalSync(false, (data) => sent.push(data), () => {}, undefined, (cwd) => changed.push(cwd));
    sync.setTarget("/old");
    sync.prompt("/old");
    sync.input("sleep 2; cd /shell\r");
    sync.setTarget("/pane");
    sync.prompt("/shell");
    expect(changed).toEqual([]);
    expect(sent).toEqual(["cd -- '/pane'\r"]);
  });

  it("sends path data to a widget instead of a history-producing command", () => {
    const marker = "1234567890abcdef1234567890abcdef";
    const data = directoryCommand("/tmp/O'Brien õ", false, marker);
    expect(data).toMatch(/^SC[a-f0-9]{32}:[A-Za-z0-9+/=]+\x1b\[633;[a-f0-9]{32}~$/);
    expect(new TextDecoder().decode(Uint8Array.from(atob(data.slice(35).split("\x1b")[0]), c => c.charCodeAt(0)))).toBe("/tmp/O'Brien õ");
    expect(data).not.toContain("cd -- ");
  });
});
