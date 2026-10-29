import { describe, expect, it } from "vitest";
import { TerminalEcho } from "./terminalEcho";

const marker = "1234567890abcdef1234567890abcdef";
const prefix = `\x1b]633;SC:${marker}:`;
const bytes = (value: string) => new TextEncoder().encode(value);
const text = (value?: Uint8Array) => value && new TextDecoder().decode(value);

describe("automatic terminal command output", () => {
  it("hides a successful command even when its markers span output chunks", () => {
    const echo = new TerminalEcho(marker);
    echo.begin("cd '/a'\r");
    expect(echo.push(bytes("c\bcd '/a'\r\n" + prefix + "O"))).toBeUndefined();
    expect(echo.push(bytes("K\x07\r\n" + prefix + "L2E="))).toBeUndefined();
    expect(text(echo.push(bytes("\x07new prompt")))).toBe(`\r\x1b[2K${prefix}OK\x07${prefix}L2E=\x07new prompt`);
    expect(text(echo.push(bytes("normal output")))).toBe("normal output");
  });

  it("preserves errors and the original command on failure", () => {
    const echo = new TerminalEcho(marker);
    echo.begin("cd /missing\r");
    const output = `cd /missing\r\nNo such directory\r\n${prefix}L29sZA==\x07`;
    expect(text(echo.push(bytes(output)))).toBe(output);
  });

  it("replays buffered output when input interrupts the change", () => {
    const echo = new TerminalEcho(marker);
    echo.begin("command echo\r");
    echo.push(bytes("command echo"));
    expect(text(echo.cancel())).toBe("command echo");
    expect(text(echo.push(bytes("user input")))).toBe("user input");
  });

  it("does not hide unrelated output from another process", () => {
    const echo = new TerminalEcho(marker);
    echo.begin("cd /a\r");
    const output = `background message\r\ncd /a\r\n${prefix}OK\x07\r\n${prefix}L2E=\x07`;
    expect(text(echo.push(bytes(output)))).toBe(output);
  });
});
