import { useEffect, useRef, useState, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowRight,
  Search,
  LoaderCircle,
  Server,
  ShieldCheck,
  AlertTriangle,
  Check,
  SlidersHorizontal,
  Keyboard,
  ExternalLink,
} from "lucide-react";
import * as api from "../api";
import { basename, join, size, uid } from "../utils";
import { FileIcon, Modal } from "./Primitives";
import { Select } from "./Select";
import type {
  Entry,
  JobRequest,
  Location,
  Operation,
  RenameItem,
  RenameRules,
  Settings,
  SftpProfile,
} from "../types";
import type { Text } from "../i18n";

export type ActionData = {
  operation: Operation | "mkdir";
  source: Location;
  entries: Entry[];
  destination: Location;
};
export function ActionDialog({
  data,
  t,
  onClose,
  onSubmit,
  onDone,
}: {
  data: ActionData;
  t: Text;
  onClose: () => void;
  onSubmit: (request: JobRequest) => Promise<void>;
  onDone: () => void;
}) {
  const [path, setPath] = useState(data.destination.path);
  const [name, setName] = useState(
    data.operation === "zip"
      ? `${data.entries.length === 1 ? basename(data.entries[0].path).replace(/\.[^.]+$/, "") : "Archive"}.zip`
      : "",
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const deleting = data.operation === "delete" || data.operation === "trash";
  const title =
    data.operation === "delete"
      ? t.confirmDelete
      : data.operation === "trash"
        ? t.confirmTrash
        : t[data.operation];
  return (
    <Modal title={title} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            if (data.operation === "mkdir")
              await api.command("create_directory", {
                location: data.source,
                name,
              });
            else
              await onSubmit({
                id: uid(),
                operation: data.operation,
                source: data.source.source,
                paths: data.entries.map((e) => e.path),
                destination: {
                  ...data.destination,
                  path: data.operation === "zip" ? join(path, name) : path,
                },
                conflict: "ask",
              });
            if (data.operation === "mkdir") onDone();
            onClose();
          } catch (e) {
            setError(String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {deleting ? (
          <div
            className={`deletion-note ${data.operation === "delete" ? "danger" : ""}`}
          >
            <AlertTriangle size={20} />
            <p>
              {data.operation === "delete"
                ? data.source.source === "local"
                  ? t.irreversible
                  : t.remoteDelete
                : t.trashHint}
            </p>
          </div>
        ) : (
          data.operation !== "mkdir" && (
            <div className="transfer-route">
              <span>{data.source.path}</span>
              <ArrowRight size={16} />
              <span>
                {data.entries.length} {t.items}
              </span>
            </div>
          )
        )}
        {data.entries.length > 0 && (
          <div className="selection-summary">
            {data.entries.slice(0, 5).map((e) => (
              <div key={e.path}>
                <FileIcon entry={e} />
                <span>{e.name}</span>
                <small>{e.isDir ? t.folder : size(e.size)}</small>
              </div>
            ))}
            {data.entries.length > 5 && (
              <small>
                +{data.entries.length - 5} {t.items}
              </small>
            )}
          </div>
        )}
        {data.operation === "mkdir" && (
          <label className="field">
            {t.folderName}
            <input
              autoFocus
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
        )}
        {!deleting && data.operation !== "mkdir" && (
          <label className="field">
            {t.destination}
            <input
              required
              value={path}
              onChange={(e) => setPath(e.target.value)}
            />
          </label>
        )}
        {data.operation === "zip" && (
          <label className="field">
            {t.zipName}
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
        )}
        {data.operation === "move" && <p className="helper">{t.moveHint}</p>}
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <footer className="modal-actions">
          <button type="button" onClick={onClose}>
            {t.cancel}
          </button>
          <button
            type="submit"
            className={
              data.operation === "delete" ? "danger-button" : "primary"
            }
            disabled={busy}
          >
            {busy && <LoaderCircle size={14} className="spin" />}
            {title}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

const defaultRules: RenameRules = {
  find: "",
  replace: "",
  regex: false,
  caseMode: "keep",
  numbering: false,
  start: 1,
  prefix: "",
};
export function RenameDialog({
  entries,
  source,
  t,
  onClose,
  onDone,
}: {
  entries: Entry[];
  source: string;
  t: Text;
  onClose: () => void;
  onDone: () => void;
}) {
  const single = entries.length === 1;
  const [rules, setRules] = useState<RenameRules>(
    single
      ? { ...defaultRules, find: entries[0].name, replace: entries[0].name }
      : defaultRules,
  );
  const [preview, setPreview] = useState<RenameItem[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [validating, setValidating] = useState(true);
  const paths = useRef(entries.map((e) => e.path));
  useEffect(() => {
    let alive = true;
    setValidating(true);
    setError("");
    const timer = setTimeout(
      () =>
        api
          .command<RenameItem[]>("rename_preview", {
            source,
            paths: paths.current,
            rules,
          })
          .then((items) => {
            if (alive) setPreview(items);
          })
          .catch((e) => {
            if (alive) {
              setError(String(e));
              setPreview([]);
            }
          })
          .finally(() => {
            if (alive) setValidating(false);
          }),
      180,
    );
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [rules, source]);
  const update = (patch: Partial<RenameRules>) =>
    setRules((r) => ({ ...r, ...patch }));
  return (
    <Modal
      title={t.rename}
      subtitle={t.renameHint}
      onClose={onClose}
      wide={!single}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api.command("rename_apply", {
              source,
              paths: paths.current,
              rules,
            });
            onDone();
            onClose();
          } catch (e) {
            setError(String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {single ? (
          <label className="field">
            {t.newName}
            <input
              autoFocus
              value={rules.replace}
              onChange={(e) => update({ replace: e.target.value })}
            />
          </label>
        ) : (
          <>
            <div className="form-grid">
              <label className="field">
                {t.find}
                <input
                  autoFocus
                  value={rules.find}
                  onChange={(e) => update({ find: e.target.value })}
                />
              </label>
              <label className="field">
                {t.replaceWith}
                <input
                  value={rules.replace}
                  onChange={(e) => update({ replace: e.target.value })}
                />
              </label>
              <label className="field">
                {t.prefix}
                <input
                  value={rules.prefix}
                  onChange={(e) => update({ prefix: e.target.value })}
                />
              </label>
              <label className="field">
                {t.caseMode}
                <Select
                  label={t.caseMode}
                  value={rules.caseMode}
                  onChange={(value) =>
                    update({ caseMode: value as RenameRules["caseMode"] })
                  }
                  options={(["keep", "lower", "upper"] as const).map(
                    (value) => ({ value, label: t[value] }),
                  )}
                />
              </label>
            </div>
            <div className="checkbox-row">
              <label>
                <input
                  type="checkbox"
                  checked={rules.regex}
                  onChange={(e) => update({ regex: e.target.checked })}
                />
                {t.regex}
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={rules.numbering}
                  onChange={(e) => update({ numbering: e.target.checked })}
                />
                {t.numbering}
              </label>
              {rules.numbering && (
                <label>
                  {t.start}
                  <input
                    className="number-input"
                    type="number"
                    min={0}
                    max={1000000000}
                    value={rules.start}
                    onChange={(e) => update({ start: Number(e.target.value) })}
                  />
                </label>
              )}
            </div>
          </>
        )}
        <div className="rename-preview">
          <div className="rename-heading">
            <span>{t.before}</span>
            <span>{t.after}</span>
          </div>
          {preview.map((item) => (
            <div key={item.path} className={item.error ? "invalid" : ""}>
              <span>{item.before}</span>
              <span>
                {item.after}
                {item.error && <small>{item.error}</small>}
              </span>
            </div>
          ))}
        </div>
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <footer className="modal-actions">
          <button type="button" onClick={onClose}>
            {t.cancel}
          </button>
          <button
            className="primary"
            type="submit"
            disabled={
              busy ||
              validating ||
              !preview.length ||
              !!error ||
              preview.some((i) => i.error)
            }
          >
            {busy ? (
              <LoaderCircle className="spin" size={14} />
            ) : (
              <Check size={14} />
            )}{" "}
            {t.apply}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

export function SearchDialog({
  location,
  t,
  showHidden,
  onClose,
  onNavigate,
}: {
  location: Location;
  t: Text;
  showHidden: boolean;
  onClose: () => void;
  onNavigate: (location: Location) => void;
}) {
  const [query, setQuery] = useState("");
  const [min, setMin] = useState("");
  const [max, setMax] = useState("");
  const [after, setAfter] = useState("");
  const [before, setBefore] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [results, setResults] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const searchId = useRef<string | undefined>(undefined);
  const alive = useRef(true);
  const scroll = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: results.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 48,
    overscan: 10,
  });
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (searchId.current && api.desktop)
        api.command("cancel_search", { id: searchId.current }).catch(() => {});
    };
  }, []);
  return (
    <Modal
      title={t.search}
      subtitle={`${t.searchIn} · ${location.path}`}
      onClose={onClose}
      wide
    >
      <form
        className="search-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const id = uid();
          searchId.current = id;
          setBusy(true);
          setResults([]);
          setError("");
          const all: Entry[] = [];
          try {
            await api.search(
              id,
              location,
              {
                query,
                minSize: min ? Number(min) : undefined,
                maxSize: max ? Number(max) : undefined,
                after: after ? Date.parse(after) / 1000 : undefined,
                before: before ? Date.parse(before) / 1000 + 86399 : undefined,
                showHidden,
              },
              (batch) => {
                if (!alive.current || searchId.current !== id) return;
                all.push(...batch.entries);
                setResults([...all]);
                if (batch.error) setError(batch.error);
                if (batch.done) setBusy(false);
              },
            );
          } catch (e) {
            if (alive.current) setError(String(e));
          } finally {
            if (alive.current && searchId.current === id) setBusy(false);
          }
        }}
      >
        <div className="search-input-row">
          <Search size={17} />
          <input
            autoFocus
            aria-label={t.query}
            placeholder={t.query}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button
            type="button"
            className="icon-button"
            title={t.details}
            aria-label={t.details}
            onClick={() => setAdvanced((v) => !v)}
          >
            <SlidersHorizontal size={16} />
          </button>
          <button className="primary" disabled={busy} type="submit">
            {busy ? <LoaderCircle className="spin" size={14} /> : t.search}
          </button>
        </div>
        {advanced && (
          <div className="form-grid search-filters">
            <label className="field">
              {t.minSize}
              <input
                type="number"
                min="0"
                value={min}
                onChange={(e) => setMin(e.target.value)}
              />
            </label>
            <label className="field">
              {t.maxSize}
              <input
                type="number"
                min={min || "0"}
                value={max}
                onChange={(e) => setMax(e.target.value)}
              />
            </label>
            <label className="field">
              {t.afterDate}
              <input
                type="date"
                value={after}
                onChange={(e) => setAfter(e.target.value)}
              />
            </label>
            <label className="field">
              {t.beforeDate}
              <input
                type="date"
                value={before}
                min={after}
                onChange={(e) => setBefore(e.target.value)}
              />
            </label>
          </div>
        )}
      </form>
      <div className="search-summary">
        <span>
          {results.length} {t.searchResults.toLowerCase()}
        </span>
        {busy && (
          <button
            onClick={() => {
              if (searchId.current)
                api
                  .command("cancel_search", { id: searchId.current })
                  .catch((e) => setError(String(e)));
            }}
          >
            {t.stopSearch}
          </button>
        )}
      </div>
      <div className="search-results" ref={scroll}>
        <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
          {virtual.getVirtualItems().map((row) => {
            const e = results[row.index];
            return (
              <button
                key={e.path}
                className="search-result"
                style={{ transform: `translateY(${row.start}px)` }}
                onClick={() => {
                  onNavigate({
                    ...location,
                    path: e.isDir ? e.path : parentPath(e.path),
                  });
                  onClose();
                }}
              >
                <FileIcon entry={e} />
                <span>
                  <strong>{e.name}</strong>
                  <small>{e.path}</small>
                </span>
                <ExternalLink size={13} />
              </button>
            );
          })}
        </div>
        {!busy && !results.length && (
          <div className="empty-state">
            <Search size={28} />
            <p>{t.noResults}</p>
          </div>
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
function parentPath(path: string) {
  const sep = path.includes("\\") ? "\\" : "/";
  const n = path.lastIndexOf(sep);
  const p = path.slice(0, n);
  return /^[A-Za-z]:$/.test(p) ? p + "\\" : p || "/";
}

export function SettingsDialog({
  settings,
  t,
  update,
  onClose,
}: {
  settings: Settings;
  t: Text;
  update: (patch: Partial<Settings>) => void;
  onClose: () => void;
}) {
  return (
    <Modal title={t.settings} onClose={onClose}>
      <div className="settings-section">
        <h3>
          <SlidersHorizontal size={15} />
          {t.appearance}
        </h3>
        <label className="setting-row">
          <span>{t.theme}</span>
          <Select
            label={t.theme}
            value={settings.theme}
            onChange={(value) => update({ theme: value as Settings["theme"] })}
            options={(["dark", "light", "system"] as const).map((value) => ({
              value,
              label: t[value],
            }))}
          />
        </label>
        <label className="setting-row">
          <span>
            <strong>{t.glass}</strong>
            <small>{t.glassHint}</small>
          </span>
          <input
            aria-label={t.glass}
            type="checkbox"
            role="switch"
            checked={settings.glass}
            onChange={(e) => update({ glass: e.target.checked })}
          />
        </label>
        <label className="setting-row">
          <span>
            <strong>{t.transparency}</strong>
            <small>{t.transparencyHint}</small>
          </span>
          <span className="transparency-control">
            <input
              aria-label={t.transparency}
              type="range"
              min={0}
              max={70}
              step={1}
              disabled={!settings.glass}
              value={settings.transparency ?? 15}
              onChange={(e) => update({ transparency: Number(e.target.value) })}
            />
            <output>
              {settings.glass ? (settings.transparency ?? 15) : 0}%
            </output>
          </span>
        </label>
        <label className="setting-row">
          <span>{t.density}</span>
          <Select
            label={t.density}
            value={settings.density}
            onChange={(value) =>
              update({ density: value as Settings["density"] })
            }
            options={(["comfortable", "compact"] as const).map((value) => ({
              value,
              label: t[value],
            }))}
          />
        </label>
        <label className="setting-row">
          <span>{t.language}</span>
          <Select
            label={t.language}
            value={settings.language}
            onChange={(value) =>
              update({ language: value as Settings["language"] })
            }
            options={[
              { value: "en", label: "English" },
              { value: "et", label: "Eesti" },
            ]}
          />
        </label>
        <label className="setting-row">
          <span>{t.hidden}</span>
          <input
            type="checkbox"
            checked={settings.showHidden}
            onChange={(e) => update({ showHidden: e.target.checked })}
          />
        </label>
      </div>
      <div className="settings-section">
        <h3>
          <Keyboard size={15} />
          {t.keyboard}
        </h3>
        <div className="shortcut-grid">
          {[
            ["F2", t.rename],
            ["F3", t.preview],
            ["F4", t.edit],
            ["F5", t.copy],
            ["F6", t.move],
            ["F7", t.mkdir],
            ["F8 / Delete", t.trash],
            ["Shift+F8", t.delete],
            ["Shift+Delete", t.delete],
            ["Ctrl+P", t.commandPalette],
            ["Ctrl+F", t.search],
            ["Ctrl+T", t.newTab],
            ["Ctrl+`", t.terminal],
            ["Ctrl+O", t.fullTerminal],
            ["Ctrl+U", t.swap],
            ["Ctrl+H", t.hidden],
            ["Ctrl+,", t.settings],
            ["F9", t.actions],
          ].map(([key, label]) => (
            <div key={key}>
              <span>{label}</span>
              <kbd>{key}</kbd>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}

export function ConnectDialog({
  profile,
  settings,
  t,
  onClose,
  onConnected,
  onForget,
  configRevision,
  onSaveProfile,
}: {
  profile?: SftpProfile;
  settings: Settings;
  t: Text;
  onClose: () => void;
  onConnected: (
    profile: SftpProfile,
    fingerprint: string,
    path: string,
    forwardErrors: string[],
  ) => void;
  onForget: (id: string) => void;
  configRevision?: string | null;
  onSaveProfile: (
    profile: SftpProfile,
    secret: string,
    revision: string | null | undefined,
  ) => Promise<{ profile: SftpProfile; revision: string | null }>;
}) {
  const [value, setValue] = useState<SftpProfile>(
    profile || {
      id: uid(),
      name: "",
      host: "",
      port: 22,
      username: "",
      keyPath: "",
      saveSecret: false,
    },
  );
  const [secret, setSecret] = useState("");
  const [fingerprint, setFingerprint] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const revision = useRef(configRevision);
  const secretTouched = useRef(false);
  useEffect(() => {
    if (!api.desktop) return;
    let active = true;
    api
      .command<boolean>("has_connection_secret", { id: value.id })
      .then((exists) => {
        if (active && !secretTouched.current)
          setValue((v) => ({ ...v, saveSecret: exists }));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [value.id]);
  const known = settings.trustedHosts[`${value.host}:${value.port}`];
  function update(patch: Partial<SftpProfile>) {
    setValue((p) => ({ ...p, ...patch }));
    setFingerprint("");
    setSaved(false);
  }
  async function connect(trust?: string) {
    setBusy(true);
    setError("");
    try {
      const result = await api.command<{
        fingerprint: string;
        needsTrust: boolean;
        path: string;
        forwardErrors: string[];
      }>("connect_sftp", {
        profile: { ...value, name: value.name || value.host },
        secret,
        expected: trust || known || null,
        configPath: settings.sshConfigPath || null,
      });
      if (result.needsTrust) setFingerprint(result.fingerprint);
      else {
        onConnected(
          { ...value, name: value.name || value.host },
          result.fingerprint,
          result.path,
          result.forwardErrors,
        );
        onClose();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={t.connect}
      subtitle="SFTP · SSH File Transfer Protocol"
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void connect();
        }}
      >
        <div className="connection-icon">
          <Server size={25} strokeWidth={1.3} />
        </div>
        <label className="field">
          {t.connectionName}
          <input
            autoFocus
            value={value.name}
            onChange={(e) => update({ name: e.target.value })}
            placeholder="My server"
          />
        </label>
        <p className="helper">{t.aliasHint}</p>
        <div className="form-grid host-grid">
          <label className="field">
            {t.host}
            <input
              required
              value={value.host}
              onChange={(e) => update({ host: e.target.value })}
              placeholder="sftp.example.com"
            />
          </label>
          <label className="field">
            {t.port}
            <input
              required
              type="number"
              min={1}
              max={65535}
              value={value.port}
              onChange={(e) => update({ port: Number(e.target.value) })}
            />
          </label>
        </div>
        <label className="field">
          {t.username}
          <input
            required
            value={value.username}
            onChange={(e) => update({ username: e.target.value })}
            autoComplete="username"
          />
        </label>
        <label className="field">
          {t.password}
          <input
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        <label className="field">
          {t.keyPath}
          <input
            value={value.keyPath}
            onChange={(e) => update({ keyPath: e.target.value })}
          />
        </label>
        <label className="check-label">
          <input
            type="checkbox"
            checked={value.saveSecret}
            onChange={(e) => {
              secretTouched.current = true;
              update({ saveSecret: e.target.checked });
            }}
          />
          {t.remember}
        </label>
        {fingerprint && (
          <div className="host-trust">
            <h3>
              <ShieldCheck size={17} />
              {t.hostTrust}
            </h3>
            <p>
              {known && known !== fingerprint ? t.changedKey : t.hostTrustHint}
            </p>
            <code>{fingerprint}</code>
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => void connect(fingerprint)}
            >
              {t.trustConnect}
            </button>
          </div>
        )}
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        {saved && <p className="helper">{t.connectionSavedConfig}</p>}
        <footer className="modal-actions">
          {profile && settings.profiles.some((p) => p.id === profile.id) && (
            <button
              type="button"
              className="text-danger"
              onClick={() => {
                onForget(profile.id);
                onClose();
              }}
            >
              {t.forget}
            </button>
          )}
          <button type="button" onClick={onClose}>
            {t.cancel}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={async (e) => {
              if (!e.currentTarget.closest("form")?.reportValidity()) return;
              setBusy(true);
              setError("");
              try {
                const result = await onSaveProfile(
                  { ...value, name: value.name || value.host },
                  secret,
                  revision.current,
                );
                revision.current = result.revision;
                setValue(result.profile);
                setSaved(true);
              } catch (e) {
                setError(String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {t.saveConnection}
          </button>
          <button className="primary" type="submit" disabled={busy}>
            {busy ? (
              <LoaderCircle className="spin" size={14} />
            ) : (
              <Server size={14} />
            )}{" "}
            {busy ? t.connecting : t.connectNow}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

export type PaletteAction = {
  id: string;
  label: string;
  icon: ReactNode;
  key?: string;
  run: () => void;
};
export function Palette({
  actions,
  t,
  onClose,
}: {
  actions: PaletteAction[];
  t: Text;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const filtered = actions.filter((a) =>
    a.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  return (
    <Modal title={t.commandPalette} onClose={onClose}>
      <div className="palette-search">
        <Search size={18} />
        <input
          autoFocus
          placeholder={t.searchHint}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((n) => Math.min(filtered.length - 1, n + 1));
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((n) => Math.max(0, n - 1));
            }
            if (e.key === "Enter" && filtered[active]) {
              onClose();
              filtered[active].run();
            }
          }}
        />
      </div>
      <div className="palette-list">
        {filtered.map((a, i) => (
          <button
            key={a.id}
            className={active === i ? "highlighted" : ""}
            onMouseEnter={() => setActive(i)}
            onClick={() => {
              onClose();
              a.run();
            }}
          >
            {a.icon}
            <span>{a.label}</span>
            {a.key && <kbd>{a.key}</kbd>}
          </button>
        ))}
      </div>
    </Modal>
  );
}
