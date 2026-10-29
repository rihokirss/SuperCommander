import { useEffect, useId, useRef, useState, type ReactNode } from "react";
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
  RefreshCw,
  FolderOpen,
  Compass,
  CheckSquare,
  PanelsTopLeft,
  FilePenLine,
  History,
  FileText,
  ArrowDownUp,
} from "lucide-react";
import { shortcutGroups } from "../shortcuts";
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
    <Modal closeLabel={t.close} title={title} onClose={onClose}>
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
            else {
              const submitted = onSubmit({
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
              // The queue owns the submitted operation, including inspection
              // progress and cancellation while a large selection is checked.
              onClose();
              await submitted;
              return;
            }
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
function RenamePreview({
  items,
  density,
  t,
}: {
  items: RenameItem[];
  density: Settings["density"];
  t: Text;
}) {
  const list = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(0);
  const height = density === "compact" ? 32 : 40;
  const rows = useVirtualizer({
    count: items.length,
    getScrollElement: () => list.current,
    estimateSize: () => height,
    overscan: 5,
  });
  const active = Math.min(focused, Math.max(0, items.length - 1));
  return (
    <div
      className="rename-preview"
      role="grid"
      aria-label={t.rename}
      aria-rowcount={items.length + 1}
      aria-colcount={2}
      tabIndex={0}
      aria-activedescendant={items.length ? `rename-row-${active}` : undefined}
      onKeyDown={(e) => {
        const step = Math.max(
          1,
          Math.floor((list.current?.clientHeight || 240) / height),
        );
        const next =
          e.key === "Home"
            ? 0
            : e.key === "End"
              ? items.length - 1
              : e.key === "ArrowUp"
                ? active - 1
                : e.key === "ArrowDown"
                  ? active + 1
                  : e.key === "PageUp"
                    ? active - step
                    : e.key === "PageDown"
                      ? active + step
                      : undefined;
        if (next === undefined) return;
        e.preventDefault();
        const index = Math.max(0, Math.min(items.length - 1, next));
        setFocused(index);
        rows.scrollToIndex(index);
      }}
    >
      <div className="rename-heading" role="row" aria-rowindex={1}>
        <span role="columnheader">{t.before}</span>
        <span role="columnheader">{t.after}</span>
      </div>
      <div
        className="rename-list"
        ref={list}
        style={{
          height: Math.min(240, Math.max(height, items.length * height)),
        }}
      >
        <div style={{ height: rows.getTotalSize(), position: "relative" }}>
          {rows.getVirtualItems().map((row) => {
            const item = items[row.index];
            return (
              <div
                key={item.path}
                id={`rename-row-${row.index}`}
                role="row"
                aria-rowindex={row.index + 2}
                className={`rename-row ${item.error ? "invalid" : ""} ${row.index === active ? "focused" : ""}`}
                style={{
                  height,
                  position: "absolute",
                  width: "100%",
                  transform: `translateY(${row.start}px)`,
                }}
                onClick={(e) => {
                  setFocused(row.index);
                  e.currentTarget
                    .closest<HTMLElement>('[role="grid"]')
                    ?.focus();
                }}
              >
                <span role="gridcell" data-tooltip={item.path}>
                  {item.before}
                </span>
                <span
                  role="gridcell"
                  data-tooltip={[item.after, item.error]
                    .filter(Boolean)
                    .join(" · ")}
                >
                  {item.after}
                  {item.error && <small> · {item.error}</small>}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
export function RenameDialog({
  entries,
  source,
  t,
  onClose,
  onDone,
  density,
}: {
  entries: Entry[];
  source: string;
  t: Text;
  onClose: () => void;
  onDone: () => void;
  density: Settings["density"];
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
  const [generation, setGeneration] = useState(0);
  const [help, setHelp] = useState(false);
  const paths = useRef(entries.map((e) => e.path));
  const review = useRef<string | undefined>(undefined);
  const applying = useRef<string | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (applying.current)
        void api
          .command("cancel_search", { id: applying.current })
          .catch(() => {});
    };
  }, []);
  useEffect(() => {
    let alive = true;
    const id = uid();
    review.current = undefined;
    setValidating(true);
    setError("");
    const timer = setTimeout(
      () =>
        api
          .command<{ id: string; items: RenameItem[] }>("rename_preview", {
            id,
            source,
            paths: paths.current,
            rules,
          })
          .then((result) => {
            if (alive) {
              review.current = result.id;
              setPreview(result.items);
            } else void api.command("release_rename", { id }).catch(() => {});
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
      void api.command("cancel_search", { id }).catch(() => {});
      void api.command("release_rename", { id }).catch(() => {});
    };
  }, [rules, source, generation]);
  function refreshPreview() {
    if (busy) return;
    review.current = undefined;
    setValidating(true);
    setGeneration((n) => n + 1);
  }
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const dialogs = document.querySelectorAll(
        '[role="dialog"][aria-modal="true"]',
      );
      const form = dialogs[dialogs.length - 1]?.querySelector<HTMLFormElement>(
        ":scope > .rename-form",
      );
      if (!form) return;
      if (e.key === "F5" || (e.ctrlKey && e.key.toLowerCase() === "r")) {
        e.preventDefault();
        e.stopPropagation();
        if (!busy) {
          review.current = undefined;
          setValidating(true);
          setGeneration((n) => n + 1);
        }
      } else if (e.key === "F1") {
        e.preventDefault();
        e.stopPropagation();
        setHelp(true);
      } else if (e.key === "Enter" && e.ctrlKey) {
        e.preventDefault();
        e.stopPropagation();
        form.requestSubmit();
      }
    };
    // A failed operation disables its submit button and can leave focus on body.
    // Dialog shortcuts must still work there, while yielding to nested help.
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, [busy]);
  const update = (patch: Partial<RenameRules>) => {
    review.current = undefined;
    setValidating(true);
    setRules((r) => ({ ...r, ...patch }));
  };
  return (
    <Modal
      closeLabel={t.close}
      title={t.rename}
      subtitle={t.renameHint}
      onClose={onClose}
      wide={!single}
    >
      <form
        className="rename-form"
        onSubmit={async (e) => {
          e.preventDefault();
          // Enter submits forms even when a pending preview disables Apply.
          if (
            busy ||
            validating ||
            !review.current ||
            !preview.length ||
            error ||
            preview.some((i) => i.error)
          )
            return;
          const id = uid();
          applying.current = id;
          setBusy(true);
          try {
            await api.command("rename_apply", {
              id,
              plan: review.current,
            });
            onDone();
            if (mounted.current) onClose();
          } catch (e) {
            onDone(); // A failed batch can have names which could not roll back.
            if (mounted.current) setError(String(e));
          } finally {
            applying.current = undefined;
            review.current = undefined;
            if (mounted.current) setBusy(false);
          }
        }}
      >
        {single ? (
          <label className="field">
            {t.newName}
            <input
              autoFocus
              disabled={busy}
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
                  disabled={busy}
                  value={rules.find}
                  onChange={(e) => update({ find: e.target.value })}
                />
              </label>
              <label className="field">
                {t.replaceWith}
                <input
                  value={rules.replace}
                  disabled={busy}
                  onChange={(e) => update({ replace: e.target.value })}
                />
              </label>
              <label className="field">
                {t.prefix}
                <input
                  value={rules.prefix}
                  disabled={busy}
                  onChange={(e) => update({ prefix: e.target.value })}
                />
              </label>
              <label className="field">
                {t.caseMode}
                <Select
                  label={t.caseMode}
                  value={rules.caseMode}
                  disabled={busy}
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
                  disabled={busy}
                  checked={rules.regex}
                  onChange={(e) => update({ regex: e.target.checked })}
                />
                {t.regex}
              </label>
              <label>
                <input
                  type="checkbox"
                  disabled={busy}
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
                    disabled={busy}
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
        <RenamePreview items={preview} density={density} t={t} />
        {validating && (
          <p className="helper" role="status">
            <LoaderCircle className="spin" size={14} /> {t.checkingRename}
          </p>
        )}
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <footer className="modal-actions">
          <button
            type="button"
            className="rename-refresh"
            onClick={refreshPreview}
            disabled={busy}
            data-tooltip={t.refresh}
            data-shortcut="F5 / Ctrl+R"
          >
            <RefreshCw size={14} />
            {t.refresh}
          </button>
          <button type="button" onClick={onClose}>
            {t.cancel}
          </button>
          <button
            className="primary"
            type="submit"
            disabled={
              busy ||
              !review.current ||
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
      {help && (
        <ShortcutsDialog
          t={t}
          initialCategory={t.rename}
          onClose={() => setHelp(false)}
        />
      )}
    </Modal>
  );
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
    <div className="settings-preview">
      <Modal closeLabel={t.close} title={t.settings} onClose={onClose}>
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
              onChange={(value) =>
                update({ theme: value as Settings["theme"] })
              }
              options={(["dark", "light", "system"] as const).map((value) => ({
                value,
                label: t[value],
              }))}
            />
          </label>
          <label className="setting-row">
            <span>{t.darkPalette}</span>
            <Select
              label={t.darkPalette}
              value={settings.darkPalette || "midnightClassic"}
              onChange={(value) =>
                update({ darkPalette: value as Settings["darkPalette"] })
              }
              options={(
                [
                  "midnight",
                  "midnightClassic",
                  "graphiteBlue",
                  "midnightRed",
                  "midnightClassicRed",
                  "graphiteRed",
                ] as const
              ).map((value) => ({
                value,
                label: t[value],
              }))}
            />
          </label>
          <label className="setting-row">
            <span>{t.lightPalette}</span>
            <Select
              label={t.lightPalette}
              value={settings.lightPalette || "sky"}
              onChange={(value) =>
                update({ lightPalette: value as Settings["lightPalette"] })
              }
              options={(["sky", "ice", "azure"] as const).map((value) => ({
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
                onChange={(e) =>
                  update({ transparency: Number(e.target.value) })
                }
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
      </Modal>
    </div>
  );
}

export function ShortcutsDialog({
  t,
  onClose,
  initialCategory,
  title,
}: {
  t: Text;
  onClose: () => void;
  initialCategory?: string;
  title?: string;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState(() =>
    Math.max(
      0,
      shortcutGroups(t).findIndex((group) => group.title === initialCategory),
    ),
  );
  const helpId = useId();
  const groups = shortcutGroups(t);
  const filtered = groups.map((group) => ({
    ...group,
    items: group.items.filter((entry) =>
      entry.join(" ").toLocaleLowerCase().includes(query.toLocaleLowerCase()),
    ),
  }));
  const categories = [
    { title: t.allShortcuts, items: groups.flatMap((group) => group.items) },
    ...groups,
  ];
  return (
    <Modal
      closeLabel={t.close}
      title={title || t.keyboard}
      onClose={onClose}
      wide
    >
      <label className="field">
        <input
          autoFocus
          aria-label={t.searchShortcuts}
          placeholder={t.searchShortcuts}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setCategory(-1);
          }}
        />
      </label>
      <div className="shortcut-browser">
        <nav
          className="shortcut-categories"
          role="tablist"
          aria-label={t.shortcutCategories}
          aria-orientation="vertical"
          onKeyDown={(event) => {
            const tabs = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>(
                '[role="tab"]',
              ),
            );
            const index = tabs.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? tabs.length - 1
                  : event.key === "ArrowDown"
                    ? (index + 1) % tabs.length
                    : event.key === "ArrowUp"
                      ? (index + tabs.length - 1) % tabs.length
                      : -1;
            if (next >= 0) {
              event.preventDefault();
              tabs[next].focus();
              tabs[next].click();
            }
          }}
        >
          {categories.map((group, index) => {
            const CategoryIcon =
              [
                Keyboard,
                FolderOpen,
                Compass,
                CheckSquare,
                PanelsTopLeft,
                FilePenLine,
                History,
                FileText,
                Search,
                SlidersHorizontal,
                ArrowDownUp,
              ][index] || Keyboard;
            return (
              <button
                key={group.title}
                role="tab"
                id={`${helpId}-${index}`}
                aria-selected={category === index - 1}
                aria-controls={`${helpId}-panel`}
                tabIndex={category === index - 1 ? 0 : -1}
                onClick={() => {
                  setCategory(index - 1);
                  setQuery("");
                }}
              >
                <CategoryIcon size={14} />
                <span>{group.title}</span>
                <small>{group.items.length}</small>
              </button>
            );
          })}
        </nav>
        <div
          className="shortcut-reference"
          role="tabpanel"
          id={`${helpId}-panel`}
          aria-labelledby={`${helpId}-${category + 1}`}
          tabIndex={0}
        >
          {filtered.map((group, index) =>
            (category === -1 || category === index) && group.items.length ? (
              <section className="settings-section" key={group.title}>
                <h3>{group.title}</h3>
                <div className="shortcut-grid">
                  {group.items.map(([key, label]) => (
                    <div key={key}>
                      <span>{label}</span>
                      <kbd>{key}</kbd>
                    </div>
                  ))}
                </div>
              </section>
            ) : null,
          )}
          {filtered.every((group) => !group.items.length) && (
            <p className="helper" role="status">
              {t.noResults}
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
}

export function ConnectDialog({
  profile,
  initialError,
  initialFingerprint,
  settings,
  t,
  onClose,
  onConnected,
  onForget,
  configRevision,
  onSaveProfile,
}: {
  profile?: SftpProfile;
  initialError?: string;
  initialFingerprint?: string;
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
  const [fingerprint, setFingerprint] = useState(initialFingerprint || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError || "");
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
      closeLabel={t.close}
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
    <Modal closeLabel={t.close} title={t.commandPalette} onClose={onClose}>
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
