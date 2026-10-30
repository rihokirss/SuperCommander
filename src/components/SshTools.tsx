import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Check,
  ClipboardCopy,
  LoaderCircle,
  Plus,
  RefreshCw,
  Server,
  Play,
  Square,
  Trash2,
} from "lucide-react";
import { command, readSshCatalog } from "../api";
import { IconButton, Modal } from "./Primitives";
import type { ForwardInfo, SavedForward, SshCatalog } from "../types";
import type { Text } from "../i18n";

export function SshCatalogDialog({
  path,
  add,
  t,
  onClose,
  onUse,
}: {
  path?: string;
  add?: boolean;
  t: Text;
  onClose: () => void;
  onUse: (catalog: SshCatalog) => void;
}) {
  const [catalog, setCatalog] = useState<SshCatalog>();
  const [filePath, setFilePath] = useState(path || "");
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  const loadId = useRef(0);
  const dirty = !!catalog && text !== catalog.text;
  const starter =
    "Host new-server\n    HostName example.com\n    User username\n    Port 22\n    IdentityFile ~/.ssh/id_ed25519\n\n";
  async function load(initial = false) {
    if (dirty && !confirm(t.unsavedConfig)) return;
    const request = ++loadId.current;
    setBusy(true);
    setError("");
    try {
      const value = await readSshCatalog(filePath);
      if (request !== loadId.current) return;
      setCatalog(value);
      setFilePath(value.path);
      setText(initial && add ? starter + value.text : value.text);
    } catch (e) {
      if (request === loadId.current) setError(String(e));
    } finally {
      if (request === loadId.current) setBusy(false);
    }
  }
  useEffect(() => {
    void load(true);
  }, []);
  function close() {
    if (busy) return;
    if (dirty && !confirm(t.unsavedConfig)) return;
    onClose();
  }
  return (
    <Modal
      closeLabel={t.close}
      title={t.sshCatalog}
      subtitle={t.configHint}
      onClose={close}
      wide
    >
      <form
        className="ssh-config-path"
        onSubmit={(e) => {
          e.preventDefault();
          void load();
        }}
      >
        <label className="field">
          {t.configPath}
          <input
            aria-label={t.configPath}
            value={filePath}
            onChange={(e) => {
              ++loadId.current;
              setBusy(false);
              setFilePath(e.target.value);
            }}
          />
        </label>
        <button type="submit" disabled={busy}>
          <RefreshCw size={14} />
          {t.load}
        </button>
      </form>
      <div className="ssh-config-layout">
        <aside className="ssh-host-list">
          <div className="ssh-catalog-heading">
            <span>
              <Server size={13} />
              Host
            </span>
            <IconButton
              title={t.addConnection}
              onClick={() => {
                setText((old) => starter + old);
                editor.current?.focus();
              }}
              disabled={!catalog || busy}
            >
              <Plus size={14} />
            </IconButton>
          </div>
          {!catalog?.hosts.length && <p className="helper">{t.catalogEmpty}</p>}
          {catalog?.hosts.map((host) => (
            <button
              key={host.profile.id}
              title={[host.profile.host, ...host.warnings].join("\n")}
              onClick={() => {
                const re = new RegExp(
                  "^\\s*Host\\s+.*\\b" +
                    host.alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
                    "\\b.*$",
                  "im",
                );
                const match = re.exec(text);
                if (match && editor.current) {
                  editor.current.focus();
                  editor.current.setSelectionRange(
                    match.index,
                    match.index + match[0].length,
                  );
                  editor.current.scrollTop = Math.max(
                    0,
                    text.slice(0, match.index).split("\n").length * 19 - 80,
                  );
                }
              }}
            >
              <Server size={13} />
              <span>
                {host.alias}
                <small>
                  {host.profile.username}@{host.profile.host}
                </small>
              </span>
            </button>
          ))}
        </aside>
        <textarea
          ref={editor}
          className="ssh-config-editor"
          aria-label={t.sshCatalog}
          spellCheck={false}
          wrap="off"
          value={text}
          disabled={!catalog || busy}
          onChange={(e) => setText(e.target.value)}
        />
      </div>
      {catalog?.warnings.length ||
      catalog?.hosts.some((h) => h.warnings.length) ? (
        <details className="config-warnings">
          <summary>{t.details}</summary>
          {[
            ...(catalog?.warnings || []),
            ...(catalog?.hosts.flatMap((h) =>
              h.warnings.map((w) => `${h.alias}: ${w}`),
            ) || []),
          ].map((w, i) => (
            <p key={i}>{w}</p>
          ))}
        </details>
      ) : null}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <footer className="modal-actions">
        <button onClick={close}>{t.cancel}</button>
        <button
          disabled={!catalog || dirty || busy}
          onClick={() => {
            onUse(catalog!);
            onClose();
          }}
        >
          {t.useCatalog}
        </button>
        <button
          className="primary"
          disabled={!catalog || !dirty || busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              const value = await command<SshCatalog>("save_ssh_config", {
                path: catalog!.path,
                text,
                revision: catalog!.revision,
              });
              setCatalog(value);
              setText(value.text);
              onUse(value);
            } catch (e) {
              setError(String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? (
            <LoaderCircle size={14} className="spin" />
          ) : (
            <Check size={14} />
          )}{" "}
          {t.saveChanges}
        </button>
      </footer>
    </Modal>
  );
}

export function ForwardDialog({
  source,
  title,
  catalog,
  t,
  onClose,
  onCatalog,
  onSaveConnection,
}: {
  source: string;
  title: string;
  catalog?: SshCatalog;
  t: Text;
  onClose: () => void;
  onCatalog: (catalog: SshCatalog) => void;
  onSaveConnection: () => void;
}) {
  const [forwards, setForwards] = useState<ForwardInfo[]>([]);
  const [saved, setSaved] = useState<SavedForward[]>([]);
  type Owner = { source: string; name: string; forward: ForwardInfo };
  const [conflict, setConflict] = useState<{
    request: SavedForward;
    owner: Owner | null;
    error: string;
  } | null>(null);
  const conflictRef = useRef<HTMLDivElement>(null);
  const [localPort, setLocalPort] = useState("0");
  const [remoteHost, setRemoteHost] = useState("127.0.0.1");
  const [remotePort, setRemotePort] = useState("80");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [copied, setCopied] = useState("");
  useLayoutEffect(() => {
    if (!conflict || busy) return;
    const node = conflictRef.current;
    (node?.querySelector<HTMLButtonElement>(".primary") ||
      node?.querySelector<HTMLButtonElement>("button[data-free-port]"))?.focus();
  }, [conflict, busy]);
  const host = catalog?.hosts.find((h) => `sftp:${h.profile.id}` === source);
  const key = (f: SavedForward) =>
    `${f.localPort}/${f.remoteHost}/${f.remotePort}`;
  const active = new Map(forwards.map((f) => [key(f), f]));
  const rows: (SavedForward & { live?: ForwardInfo; saved: boolean })[] = [
    ...saved.map((f) => ({ ...f, saved: true, live: active.get(key(f)) })),
    ...forwards
      .filter((f) => !saved.some((s) => key(s) === key(f)))
      .map((f) => ({ ...f, saved: false, live: f })),
  ];
  async function refresh() {
    const [live, remembered] = await Promise.all([
      command<ForwardInfo[]>("list_forwards", { source }),
      command<SavedForward[]>("list_saved_forwards", { source }),
    ]);
    setForwards(live);
    setSaved(remembered);
  }
  async function changeSaved(forward: SavedForward, enabled: boolean) {
    const value = await command<SavedForward[]>("save_forward", {
      source,
      forward: {
        localPort: forward.localPort,
        remoteHost: forward.remoteHost,
        remotePort: forward.remotePort,
      },
      enabled,
    });
    setSaved(value);
  }
  async function start(forward: SavedForward, owner?: Owner) {
    try {
      await command("start_forward", {
        source,
        localPort: forward.localPort,
        remoteHost: forward.remoteHost,
        remotePort: forward.remotePort,
        replace: owner ? { source: owner.source, id: owner.forward.id } : null,
      });
    } catch (e) {
      if (!forward.localPort) throw e;
      const owner = await command<Owner | null>("forward_port_owner", {
        localPort: forward.localPort,
      });
      // Only offer port choices for a bind failure or an app-owned listener.
      if (!owner && !String(e).includes("Cannot bind local port")) throw e;
      setConflict({ request: forward, owner, error: String(e) });
    }
  }
  async function action(id: string, run: () => Promise<void>) {
    setBusy(id);
    setError("");
    setConflict(null);
    try {
      await run();
    } catch (e) {
      setError(String(e));
    } finally {
      await refresh().catch((e) => setError(String(e)));
      setBusy("");
    }
  }
  useEffect(() => {
    let active = true;
    const refresh = () =>
      Promise.all([
        command<ForwardInfo[]>("list_forwards", { source }),
        command<SavedForward[]>("list_saved_forwards", { source }),
      ])
        .then(([live, remembered]) => {
          if (active) {
            setForwards(live);
            setSaved(remembered);
          }
        })
        .catch((e) => {
          if (active) setError(String(e));
        });
    void refresh();
    const timer = setInterval(refresh, 1200);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [source]);
  return (
    <Modal
      closeLabel={t.close}
      title={t.forwarding}
      subtitle={`${title} · ${t.forwardHint}`}
      onClose={onClose}
      wide
    >
      <div className="forward-list">
        <table className="forward-table">
          <thead>
            <tr>
              <th>{t.localAddress}</th>
              <th>{t.forwardTarget}</th>
              <th>{t.status}</th>
              <th>{t.rememberForward}</th>
              <th>
                <span className="sr-only">{t.actions}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                className="forward-row"
                key={key(row)}
                data-forward-id={row.live?.id}
                data-local-port={row.localPort}
              >
                <td>
                  <code>127.0.0.1:{row.localPort}</code>
                </td>
                <td>
                  <code>
                    {row.remoteHost.includes(":")
                      ? `[${row.remoteHost}]`
                      : row.remoteHost}
                    :{row.remotePort}
                  </code>
                </td>
                <td>
                  <span
                    className={`forward-state ${row.live?.error ? "failed" : row.live ? "running" : ""}`}
                    data-tooltip={row.live?.error}
                  >
                    <span className="status-led" />
                    {row.live?.error
                      ? t.failed
                      : row.live
                        ? t.running
                        : t.stopped}
                  </span>
                </td>
                <td className="forward-remember">
                  <input
                    type="checkbox"
                    aria-label={`${t.rememberForward} ${row.localPort}`}
                    data-tooltip={host ? t.rememberForwardHint : t.saveConnectionFirst}
                    checked={row.saved}
                    disabled={!!busy || !host}
                    onChange={(e) => {
                      void action(key(row), () =>
                        changeSaved(row, e.target.checked),
                      );
                    }}
                  />
                </td>
                <td>
                  <div className="forward-actions">
                    <IconButton
                      title={copied === key(row) ? t.copied : t.copyAddress}
                      onClick={() => {
                        navigator.clipboard
                          .writeText(`127.0.0.1:${row.localPort}`)
                          .then(() => setCopied(key(row)))
                          .catch((e) => setError(String(e)));
                      }}
                    >
                      <ClipboardCopy size={13} />
                    </IconButton>
                    <IconButton
                      title={row.live ? t.stopForward : t.startForward}
                      disabled={!!busy}
                      onClick={() => {
                        void action(key(row), async () => {
                          if (row.live)
                            await command("stop_forward", {
                              source,
                              id: row.live.id,
                            });
                          else
                            await start(row);
                        });
                      }}
                    >
                      {busy === key(row) ? (
                        <LoaderCircle size={13} className="spin" />
                      ) : row.live ? (
                        <Square size={12} />
                      ) : (
                        <Play size={13} />
                      )}
                    </IconButton>
                    <IconButton
                      title={t.removeForward}
                      disabled={!!busy}
                      onClick={() => {
                        void action(key(row), async () => {
                          if (row.saved) await changeSaved(row, false);
                          if (row.live)
                            await command("stop_forward", {
                              source,
                              id: row.live.id,
                            });
                        });
                      }}
                    >
                      <Trash2 size={13} />
                    </IconButton>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <p className="helper">{t.noForwards}</p>}
      </div>
      {!!host?.forwards.length && catalog && (
        <div className="forward-migration">
          <p className="helper">{t.moveForwardHint}</p>
          {host.forwards.map((forward) => (
            <div key={key(forward)}>
              <code>127.0.0.1:{forward.localPort} → {forward.remoteHost}:{forward.remotePort}</code>
              <button disabled={!!busy} onClick={() => {
                void action("move", async () => {
                  const updated = await command<SshCatalog>("move_ssh_forward", {
                    source, path: catalog.path, alias: host.alias, forward,
                    revision: catalog.revision,
                  });
                  onCatalog(updated);
                });
              }}>{t.moveForward}</button>
            </div>
          ))}
        </div>
      )}
      <form
        className="forward-add"
        onSubmit={(e) => {
          e.preventDefault();
          void action("add", async () => {
            await start({
              localPort: Number(localPort),
              remoteHost,
              remotePort: Number(remotePort),
            });
          });
        }}
      >
        <input
          aria-label={t.localPort}
          data-tooltip={t.localPort}
          type="number"
          min={0}
          max={65535}
          required
          value={localPort}
          onChange={(e) => setLocalPort(e.target.value)}
        />
        <input
          aria-label={t.remoteHost}
          placeholder={t.remoteHost}
          required
          value={remoteHost}
          onChange={(e) => setRemoteHost(e.target.value)}
        />
        <input
          aria-label={t.remotePort}
          data-tooltip={t.remotePort}
          type="number"
          min={1}
          max={65535}
          required
          value={remotePort}
          onChange={(e) => setRemotePort(e.target.value)}
        />
        <button className="primary" type="submit" disabled={!!busy}>
          {busy === "add" ? (
            <LoaderCircle size={13} className="spin" />
          ) : (
            <Plus size={13} />
          )}{" "}
          {t.createForward}
        </button>
      </form>
      <p className="helper forward-hint">
        {t.rememberForwardHint}
        {!host && <> {" "}<button className="text-button" onClick={onSaveConnection}>{t.saveConnectionFirst}</button></>}
      </p>
      {conflict && (
        <div ref={conflictRef} className="forward-conflict" role="alertdialog" aria-label={t.portInUse} aria-describedby="forward-conflict-description">
          <strong>{t.portInUse}: {conflict.request.localPort}</strong>
          <p id="forward-conflict-description">
            {conflict.owner
              ? `${conflict.owner.name} · ${conflict.owner.forward.remoteHost}:${conflict.owner.forward.remotePort}. ${t.replaceForwardHint}`
              : t.externalPortHint}
          </p>
          <div className="forward-conflict-actions">
            <button disabled={!!busy} onClick={() => setConflict(null)}>{t.cancel}</button>
            <button data-free-port disabled={!!busy} onClick={() => {
              void action("free", () => start({ ...conflict.request, localPort: 0 }));
            }}>{t.useFreePort}</button>
            {conflict.owner && <button className="primary" disabled={!!busy} onClick={() => {
              void action("replace", () => start(conflict.request, conflict.owner!));
            }}>{t.replaceForward}</button>}
          </div>
        </div>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
