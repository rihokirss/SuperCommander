import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  ClipboardCopy,
  LoaderCircle,
  Plus,
  RefreshCw,
  Server,
  X,
} from "lucide-react";
import { command, readSshCatalog } from "../api";
import { IconButton, Modal } from "./Primitives";
import type { ForwardInfo, SshCatalog } from "../types";
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
  const dirty = !!catalog && text !== catalog.text;
  const starter =
    "Host new-server\n    HostName example.com\n    User username\n    Port 22\n    IdentityFile ~/.ssh/id_ed25519\n\n";
  async function load(initial = false) {
    if (dirty && !confirm(t.unsavedConfig)) return;
    setBusy(true);
    setError("");
    try {
      const value = await readSshCatalog(filePath);
      setCatalog(value);
      setFilePath(value.path);
      setText(initial && add ? starter + value.text : value.text);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
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
    <Modal title={t.sshCatalog} subtitle={t.configHint} onClose={close} wide>
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
            onChange={(e) => setFilePath(e.target.value)}
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
  t,
  onClose,
}: {
  source: string;
  title: string;
  t: Text;
  onClose: () => void;
}) {
  const [forwards, setForwards] = useState<ForwardInfo[]>([]);
  const [localPort, setLocalPort] = useState("0");
  const [remoteHost, setRemoteHost] = useState("127.0.0.1");
  const [remotePort, setRemotePort] = useState("80");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState("");
  useEffect(() => {
    let active = true;
    const refresh = () =>
      command<ForwardInfo[]>("list_forwards", { source })
        .then((v) => {
          if (active) setForwards(v);
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
      title={t.forwarding}
      subtitle={`${title} · ${t.forwardHint}`}
      onClose={onClose}
      wide
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            const value = await command<ForwardInfo>("start_forward", {
              source,
              localPort: Number(localPort),
              remoteHost,
              remotePort: Number(remotePort),
            });
            setForwards((old) => [...old, value]);
          } catch (e) {
            setError(String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="forward-form">
          <label className="field">
            {t.localPort}
            <input
              aria-label={t.localPort}
              type="number"
              min={0}
              max={65535}
              required
              value={localPort}
              onChange={(e) => setLocalPort(e.target.value)}
            />
          </label>
          <ArrowRight size={17} />
          <label className="field">
            {t.remoteHost}
            <input
              aria-label={t.remoteHost}
              required
              value={remoteHost}
              onChange={(e) => setRemoteHost(e.target.value)}
            />
          </label>
          <label className="field">
            {t.remotePort}
            <input
              aria-label={t.remotePort}
              required
              type="number"
              min={1}
              max={65535}
              value={remotePort}
              onChange={(e) => setRemotePort(e.target.value)}
            />
          </label>
          <button className="primary" type="submit" disabled={busy}>
            {busy ? (
              <LoaderCircle size={14} className="spin" />
            ) : (
              <Plus size={14} />
            )}{" "}
            {t.createForward}
          </button>
        </div>
      </form>
      <div className="forward-list">
        {!forwards.length ? (
          <p className="helper">{t.noForwards}</p>
        ) : (
          forwards.map((forward) => (
            <div
              className="forward-row"
              key={forward.id}
              data-forward-id={forward.id}
              data-local-port={forward.localPort}
            >
              <div>
                <span className="status-led" />
                <code>127.0.0.1:{forward.localPort}</code>
                <ArrowRight size={13} />
                <code>
                  {forward.remoteHost}:{forward.remotePort}
                </code>
                <IconButton
                  title={copied === forward.id ? t.copied : t.copyAddress}
                  onClick={() =>
                    navigator.clipboard
                      .writeText(`127.0.0.1:${forward.localPort}`)
                      .then(() => setCopied(forward.id))
                      .catch((e) => setError(String(e)))
                  }
                >
                  <ClipboardCopy size={13} />
                </IconButton>
                <button
                  onClick={async () => {
                    try {
                      await command("stop_forward", { source, id: forward.id });
                      setForwards((old) =>
                        old.filter((f) => f.id !== forward.id),
                      );
                    } catch (e) {
                      setError(String(e));
                    }
                  }}
                >
                  <X size={13} />
                  {t.stopForward}
                </button>
              </div>
              {forward.error && <p className="inline-error">{forward.error}</p>}
            </div>
          ))
        )}
      </div>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
