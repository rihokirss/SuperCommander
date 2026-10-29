export type TerminalSyncStatus = "waiting" | "synced" | "failed" | "unsupported";

// Shell markers, rather than output timing or prompt text, tell us when it is
// safe to write a command to an interactive terminal.
export class TerminalSync {
  private target: string | null = null;
  private cwd: string | null = null;
  private ready = false;
  private dirty = false;
  private inFlight: string | null = null;
  private acknowledged = false;
  private confirmed: { target: string; cwd: string } | null = null;
  private failed: string | null = null;
  private supported = true;
  constructor(
    private readonly local: boolean,
    private readonly send: (command: string) => void,
    private readonly status: (status: TerminalSyncStatus) => void,
    private readonly marker?: string,
    private readonly changed?: (path: string) => void,
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
    const previous = this.cwd;
    const followingPrevious = previous && this.target && this.matches(previous);
    this.supported = true;
    this.cwd = cwd;
    this.ready = true;
    if (this.inFlight) {
      if (this.acknowledged) this.confirmed = { target: this.inFlight, cwd };
      else if (!samePath(this.inFlight, cwd, this.local)) this.failed = this.inFlight;
      this.inFlight = null;
      this.acknowledged = false;
    } else if (previous && followingPrevious && !samePath(previous, cwd, this.local)) {
      // A user command changed directories while the pane still followed the
      // old one. Adopt that location before React updates the pane, avoiding
      // a feedback loop that would send the shell back to its previous folder.
      this.target = cwd;
      this.failed = null;
      this.confirmed = null;
      this.changed?.(cwd);
    }
    this.pump();
  }

  acknowledge() {
    if (this.inFlight) this.acknowledged = true;
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
    if (this.inFlight) {
      this.status("waiting");
      return;
    }
    if (this.cwd && this.matches(this.cwd)) {
      this.status("synced");
      return;
    }
    if (!this.ready || this.dirty) {
      this.status("waiting");
      return;
    }
    const path = this.target;
    this.inFlight = path;
    this.ready = false;
    this.status("waiting");
    this.send(directoryCommand(path, this.local, this.marker));
  }

  private matches(cwd: string) {
    return this.target !== null && (samePath(this.target, cwd, this.local) ||
      (this.confirmed?.target === this.target && samePath(this.confirmed.cwd, cwd, this.local)));
  }
}

function samePath(a: string, b: string, local: boolean) {
  if (!local) return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
  const normalize = (value: string) => value.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  return normalize(a) === normalize(b);
}

export function directoryCommand(path: string, local: boolean, marker?: string): string {
  if (/[\x00-\x1f\x7f]/.test(path)) throw new Error("Invalid terminal path");
  if (marker) {
    if (!/^[a-f\d]{32}$/i.test(marker)) throw new Error("Invalid terminal marker");
    const encoded = btoa(Array.from(new TextEncoder().encode(path), (byte) => String.fromCharCode(byte)).join(""));
    // The widget consumes and clears this data before the empty line is
    // submitted. No shell command, expansion, or history entry is created.
    return `SC${marker}:${encoded}\x18\x07`;
  }
  const command = local
    ? `Set-Location -LiteralPath '${path.replace(/'/g, "''")}'`
    : `cd -- '${path.replace(/'/g, "'\\''")}'`;
  return `${command}\r`;
}
