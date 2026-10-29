export type TerminalSyncStatus = "waiting" | "synced" | "failed" | "unsupported";

// Shell markers, rather than output timing or prompt text, tell us when it is
// safe to write a command to an interactive terminal.
export class TerminalSync {
  private target: string | null = null;
  private cwd: string | null = null;
  private ready = false;
  private dirty = false;
  private inFlight: string | null = null;
  private failed: string | null = null;
  private supported = true;
  constructor(
    private readonly local: boolean,
    private readonly send: (command: string) => void,
    private readonly status: (status: TerminalSyncStatus) => void,
  ) {}

  setTarget(path: string | null) {
    if (path !== this.target) this.failed = null;
    this.target = path;
    this.pump();
  }

  input(data: string) {
    if (!data) return;
    for (const character of data) {
      if (/[\r\n\x03\x04\x1a]/.test(character)) {
        this.ready = false;
        this.dirty = false;
      } else {
        this.dirty = true;
      }
    }
  }

  prompt(cwd: string) {
    this.supported = true;
    this.cwd = cwd;
    this.ready = true;
    if (this.inFlight) {
      if (!samePath(this.inFlight, cwd, this.local)) this.failed = this.inFlight;
      this.inFlight = null;
    }
    this.pump();
  }

  unsupported() {
    this.supported = false;
    this.status("unsupported");
  }

  private pump() {
    if (!this.target) return;
    if (!this.supported) { this.status("unsupported"); return; }
    if (this.failed === this.target || /[\x00-\x1f\x7f]/.test(this.target)) {
      this.status("failed");
      return;
    }
    if (this.cwd && samePath(this.target, this.cwd, this.local)) {
      this.status("synced");
      return;
    }
    if (!this.ready || this.dirty || this.inFlight) {
      this.status("waiting");
      return;
    }
    const path = this.target;
    this.inFlight = path;
    this.ready = false;
    this.status("waiting");
    this.send(directoryCommand(path, this.local));
  }
}

function samePath(a: string, b: string, local: boolean) {
  if (!local) return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
  const normalize = (value: string) => value.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  return normalize(a) === normalize(b);
}

export function directoryCommand(path: string, local: boolean): string {
  if (/[\x00-\x1f\x7f]/.test(path)) throw new Error("Invalid terminal path");
  return local
    ? `Set-Location -LiteralPath '${path.replace(/'/g, "''")}'\r`
    : `cd -- '${path.replace(/'/g, "'\\''")}'\r`;
}
