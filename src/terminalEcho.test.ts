import { describe, expect, it } from "vitest";
import { TerminalEcho } from "./terminalEcho";

const marker = "1234567890abcdef1234567890abcdef";
const prefix = `\x1b]633;SC:${marker}:`;
const bytes = (value: string) => new TextEncoder().encode(value);
const text = (value?: Uint8Array) => value && new TextDecoder().decode(value);

describe("automatic terminal command output", () => {
  it("replaces a cleared widget input without leaving a blank prompt", () => {
    const echo = new TerminalEcho(marker);
    const payload = `SC${marker}:L2E=`;
    echo.begin(payload + "\x18\x07");
    const output = `${prefix}OK\x07\r\n${prefix}L2E=\x07new prompt`;
    expect(text(echo.push(bytes(output)))).toBe(`\r\x1b[2K${prefix}OK\x07${prefix}L2E=\x07new prompt`);
  });
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

  it("recognizes PowerShell prompt and repeated wrapped-line redraws", () => {
    const echo = new TerminalEcho(marker);
    const command = "Set-Location -LiteralPath 'C:\\dir'; if ($?) { ok }";
    echo.begin(command + "\r");
    const output = `PS C:\\old> ${command.slice(0, 30)}${command}${prefix}OK\x07\r\n${prefix}QzpcZGly\x07`;
    expect(text(echo.push(bytes(output)))).toBe(`\r\x1b[2K${prefix}OK\x07${prefix}QzpcZGly\x07`);
  });

  it("recognizes a redraw of the previous directory command before the next one", () => {
    const echo = new TerminalEcho(marker);
    const old = "Set-Location -LiteralPath 'C:\\old'; if ($?) { ok }";
    const next = "Set-Location -LiteralPath 'C:\\new'; if ($?) { ok }";
    echo.begin(old + "\r");
    echo.cancel();
    echo.begin(next + "\r");
    const output = `${old.slice(0, -1)}${next.slice(0, 40)}${next}${prefix}OK\x07\r\n${prefix}QzpcbmV3\x07`;
    expect(text(echo.push(bytes(output)))).toBe(`\r\x1b[2K${prefix}OK\x07${prefix}QzpcbmV3\x07`);
  });
});
