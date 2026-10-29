// Hide only the echo of a successful automatic directory change. If the shell
// reports a failure, takes too long, or the user types, replay everything.
export class TerminalEcho {
  private buffer: number[] | null = null;
  private command = "";
  private readonly prefix: number[];
  private readonly success: number[];

  constructor(marker: string) {
    const encoder = new TextEncoder();
    this.prefix = Array.from(encoder.encode(`\x1b]633;SC:${marker}:`));
    this.success = Array.from(encoder.encode(`\x1b]633;SC:${marker}:OK\x07`));
  }

  begin(command: string) {
    this.command = command.replace(/[\r\n]+$/, "");
    this.buffer = [];
  }

  cancel(): Uint8Array | undefined {
    if (!this.buffer) return undefined;
    const output = Uint8Array.from(this.buffer);
    this.buffer = null;
    return output;
  }

  push(data: Uint8Array): Uint8Array | undefined {
    if (!this.buffer) return data;
    if (this.buffer.length + data.length > 65536) {
      const buffered = this.cancel()!;
      const output = new Uint8Array(buffered.length + data.length);
      output.set(buffered);
      output.set(data, buffered.length);
      return output;
    }
    this.buffer.push(...data);
    const first = find(this.buffer, this.prefix);
    if (first < 0) return undefined;
    const end = this.buffer.indexOf(7, first + this.prefix.length);
    if (end < 0) return undefined;
    const success = find(this.buffer, this.success);
    if (success !== first) return this.cancel();
    const prompt = find(this.buffer, this.prefix, success + this.success.length);
    if (prompt < 0) return undefined;
    if (this.buffer.indexOf(7, prompt + this.prefix.length) < 0) return undefined;
    // Do not discard unrelated output, such as messages from a background job.
    // Unfamiliar shell redraw sequences fall back to displaying the command.
    const echoed = new TextDecoder().decode(Uint8Array.from(this.buffer.slice(0, success)))
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/[^\x08]\x08/g, "")
      .replace(/[\r\n]/g, "")
      .trim();
    if (echoed !== this.command) return this.cancel();
    const afterSuccess = this.buffer.slice(success + this.success.length);
    // The shell normally terminates the submitted command with a newline.
    // Replace the old prompt instead of leaving it on an empty line.
    if (afterSuccess[0] === 13 && afterSuccess[1] === 10) afterSuccess.splice(0, 2);
    else if (afterSuccess[0] === 10) afterSuccess.splice(0, 1);
    this.buffer = null;
    return Uint8Array.from([13, 27, 91, 50, 75, ...this.success, ...afterSuccess]);
  }
}

function find(haystack: number[], needle: number[], from = 0) {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}
