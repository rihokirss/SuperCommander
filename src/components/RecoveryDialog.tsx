import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Eye,
  FolderOpen,
  History,
  LoaderCircle,
  Search,
  Trash2,
} from "lucide-react";
import * as api from "../api";
import { basename, size, uid } from "../utils";
import type {
  Location,
  RecoveryBatch,
  RecoveryItem,
  RecoveryReview,
} from "../types";
import type { Text } from "../i18n";
import { FileIcon, IconButton, Modal } from "./Primitives";
import { Select } from "./Select";
import { PreviewDialog } from "./PreviewDialog";
import { ShortcutsDialog } from "./Dialogs";
import "../recovery.css";

export function RecoveryDialog({
  location,
  other,
  selectedKey,
  label,
  otherLabel,
  density,
  t,
  onClose,
  onReveal,
  onQueue,
}: {
  location: Location;
  other?: Location;
  selectedKey?: string;
  label: string;
  otherLabel?: string;
  density: "compact" | "comfortable";
  t: Text;
  onClose: () => void;
  onReveal: (location: Location) => void;
  onQueue: (
    id: string,
    operation: "restore" | "delete",
    source: string,
    item: RecoveryItem,
    review?: RecoveryReview,
  ) => Promise<void>;
}) {
  const [path, setPath] = useState(location.path),
    [recursive, setRecursive] = useState(false);
  const [items, setItems] = useState(new Map<string, RecoveryItem>());
  const [progress, setProgress] = useState<RecoveryBatch>();
  const [planProgress, setPlanProgress] = useState<{
    files: number;
    bytes: number;
  }>();
  const [query, setQuery] = useState(""),
    [focused, setFocused] = useState(0);
  const [selected, setSelected] = useState<string>();
  const [name, setName] = useState(""),
    [folder, setFolder] = useState("");
  const [destination, setDestination] = useState("saved"),
    [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState<"scan" | "plan" | "queue">();
  const [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [review, setReview] = useState<RecoveryReview>();
  const [removing, setRemoving] = useState<RecoveryItem>();
  const [preview, setPreview] = useState<RecoveryItem>(),
    [help, setHelp] = useState(false);
  const alive = useRef(true),
    task = useRef<string | undefined>(undefined);
  const planId = useRef<string | undefined>(undefined),
    pending = useRef(false);
  const cancelled = useRef(new Set<string>());
  const grid = useRef<HTMLDivElement>(null),
    filter = useRef<HTMLInputElement>(null);
  const reviewList = useRef<HTMLDivElement>(null);
  const rows = useMemo(
    () =>
      [...items.values()].filter((item) =>
        [
          item.original ? basename(item.original) : "",
          basename(item.payload),
          item.kind,
        ]
          .join(" ")
          .toLowerCase()
          .includes(query.toLowerCase()),
      ),
    [items, query],
  );
  const item = selected ? items.get(selected) : undefined;
  const rowHeight = density === "compact" ? 32 : 40;
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => grid.current,
    estimateSize: () => rowHeight,
    overscan: 6,
  });
  const reviewVirtual = useVirtualizer({
    count: review?.summary.rows.length || 0,
    getScrollElement: () => reviewList.current,
    estimateSize: () => rowHeight,
    overscan: 6,
    enabled: !!review,
  });
  const canRestore =
    !!item?.entry && !item.active && !item.entry.isSymlink && !busy;
  const kindLabel = (item: RecoveryItem) =>
    item.active
      ? t.recoveryActive
      : !item.entry
        ? t.recoveryMissing
        : item.kind === "backup"
          ? t.recoveryBackup
          : item.kind === "part"
            ? t.recoveryPart
            : t.recoveryClaim;
  function cancel() {
    const id = task.current;
    if (!id) return;
    cancelled.current.add(id);
    if (api.desktop) void api.command("cancel_search", { id }).catch(() => {});
  }
  function release() {
    if (planId.current && api.desktop)
      void api
        .command("release_recovery", { id: planId.current })
        .catch(() => {});
    planId.current = undefined;
  }
  function choose(value: RecoveryItem, index: number) {
    if (pending.current) return;
    release();
    setReview(undefined);
    setSelected(value.key);
    setFocused(index);
    setName(value.original ? basename(value.original) : "Recovered");
    setFolder(value.folder);
    setDestination("saved");
    setReplace(false);
    setError("");
    setNotice("");
  }
  async function scan() {
    if (pending.current || !path.trim()) return;
    release();
    setReview(undefined);
    pending.current = true;
    const id = uid();
    task.current = id;
    setBusy("scan");
    setError("");
    setNotice("");
    setItems(new Map());
    setSelected(undefined);
    setFocused(0);
    setProgress(undefined);
    setQuery("");
    let found = new Map<string, RecoveryItem>();
    try {
      await api.scanRecovery(
        id,
        { source: location.source, path: path.trim() },
        recursive,
        (batch) => {
          if (!alive.current || task.current !== id) return;
          for (const item of batch.items) found.set(item.key, item);
          setItems(new Map(found));
          setProgress(batch);
        },
      );
      if (!alive.current || task.current !== id) return;
      // Selection is assigned after scanning so a late preferred record wins.
      pending.current = false;
      const value =
        (selectedKey && found.get(selectedKey)) || found.values().next().value;
      if (value) choose(value, [...found.keys()].indexOf(value.key));
      if (cancelled.current.has(id)) setNotice(t.recoveryStopped);
    } catch (e) {
      if (alive.current && task.current === id) setError(String(e));
    } finally {
      if (task.current === id) {
        task.current = undefined;
        pending.current = false;
        if (alive.current) setBusy(undefined);
      }
      cancelled.current.delete(id);
    }
  }
  async function prepare() {
    if (
      pending.current ||
      !canRestore ||
      !item ||
      !name.trim() ||
      !folder.trim()
    )
      return;
    release();
    pending.current = true;
    const id = uid();
    task.current = id;
    setBusy("plan");
    setPlanProgress(undefined);
    setError("");
    setNotice("");
    try {
      const result = await api.planRecovery(
        id,
        location.source,
        {
          key: item.key,
          revision: item.revision,
          connection: item.connection,
          name: name.trim(),
          replace,
          destination: {
            source:
              destination === "other" && other ? other.source : location.source,
            path: folder.trim(),
          },
        },
        (value) => {
          if (alive.current && task.current === id) setPlanProgress(value);
        },
      );
      if (!alive.current || task.current !== id || cancelled.current.has(id)) {
        if (api.desktop)
          void api
            .command("release_recovery", { id: result.id })
            .catch(() => {});
        return;
      }
      if (!result.summary.rows.length) {
        if (api.desktop)
          void api
            .command("release_recovery", { id: result.id })
            .catch(() => {});
        throw new Error(t.recoveryEmpty);
      }
      planId.current = result.id;
      setReview(result);
    } catch (e) {
      if (alive.current && task.current === id && !cancelled.current.has(id))
        setError(String(e));
    } finally {
      if (task.current === id) {
        task.current = undefined;
        pending.current = false;
        if (alive.current) setBusy(undefined);
      }
      cancelled.current.delete(id);
    }
  }
  async function queue(remove = false) {
    const value = remove ? removing : item;
    if (
      !api.desktop ||
      pending.current ||
      !value ||
      value.active ||
      (!remove && !review)
    )
      return;
    pending.current = true;
    setBusy("queue");
    setError("");
    let handedOff = false;
    try {
      const completion = onQueue(
        uid(),
        remove ? "delete" : "restore",
        location.source,
        value,
        remove ? undefined : review,
      );
      planId.current = undefined;
      setReview(undefined);
      setRemoving(undefined);
      // Disable this item immediately; the backend also checks its own lease.
      setItems((old) =>
        new Map(old).set(value.key, { ...value, active: true }),
      );
      setNotice(remove ? t.recoveryRemoved : t.recoveryQueued);
      // The Transfers queue owns the submitted task, including long inspection.
      // Keep this view usable and let it close while the RPC is still preparing.
      pending.current = false;
      setBusy(undefined);
      handedOff = true;
      await completion;
    } catch (e) {
      if (!handedOff) {
        pending.current = false;
        if (alive.current) setBusy(undefined);
      }
      if (alive.current) {
        setError(String(e));
      }
    }
  }
  async function view() {
    if (!item?.entry || item.active || busy) return;
    if (item.entry.isDir) {
      try {
        const saved = { source: location.source, path: item.payload };
        const info = await api.properties(saved, item.entry);
        if (info.connection !== item.connection)
          throw new Error(t.comparisonConnectionChanged);
        if (alive.current) onReveal(saved);
      } catch (error) {
        if (alive.current) setError(String(error));
      }
    } else setPreview(item);
  }
  useEffect(() => {
    alive.current = true;
    void scan();
    return () => {
      alive.current = false;
      cancel();
      task.current = undefined;
      pending.current = false;
      release();
    };
  }, []);
  // A stopped StrictMode mount must not prevent the replacement mount's scan.
  useEffect(() => {
    setFocused(0);
    virtual.scrollToIndex(0);
    if (!pending.current) {
      if (rows[0]) choose(rows[0], 0);
      else setSelected(undefined);
    }
  }, [query]);
  return (
    <>
      <Modal
        title={t.recovery}
        subtitle={label}
        closeLabel={t.close}
        onClose={onClose}
        wide
      >
        <div
          className="recovery-workbench"
          onKeyDown={(event) => {
            if (preview || help || review || removing) return;
            const ctrl = event.ctrlKey || event.metaKey;
            if (event.key === "F1") {
              event.preventDefault();
              event.stopPropagation();
              setHelp(true);
            } else if (
              event.key === "F5" ||
              (ctrl && event.key.toLowerCase() === "r")
            ) {
              event.preventDefault();
              event.stopPropagation();
              void scan();
            } else if (ctrl && event.key.toLowerCase() === "f") {
              event.preventDefault();
              filter.current?.focus();
            } else if (event.key === "F3") {
              event.preventDefault();
              event.stopPropagation();
              view();
            } else if (ctrl && event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              void prepare();
            }
          }}
        >
          <p className="hint">
            {api.desktop ? t.recoveryHint : t.demo + " · " + t.desktopOnly}
          </p>
          <form
            className="recovery-scan"
            onSubmit={(event) => {
              event.preventDefault();
              void scan();
            }}
          >
            <label className="field">
              <span>{t.recoverySource}</span>
              <input
                aria-label={t.recoverySource}
                value={path}
                disabled={!!busy}
                onChange={(e) => setPath(e.target.value)}
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={recursive}
                disabled={!!busy}
                onChange={(e) => setRecursive(e.target.checked)}
              />
              {t.recursiveSearch}
            </label>
            {busy === "scan" || busy === "plan" ? (
              <button type="button" onClick={cancel}>
                {t.cancel}
              </button>
            ) : (
              <button
                type="submit"
                disabled={!!busy}
                data-shortcut="F5 / Ctrl+R"
              >
                {t.scanRecovery}
              </button>
            )}
          </form>
          <div className="recovery-filter">
            <Search size={14} />
            <input
              ref={filter}
              aria-label={t.recoveryFilter}
              placeholder={t.recoveryFilter}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <small>
              {rows.length} {t.items}
              {progress && ` · ${t.recoveryScanned}: ${progress.scanned}`}
            </small>
          </div>
          <div className="recovery-body">
            <div
              className="recovery-list"
              role="listbox"
              aria-label={t.recoverySaved}
              aria-activedescendant={
                rows[focused] ? `recovery-row-${focused}` : undefined
              }
              tabIndex={0}
              ref={grid}
              onKeyDown={(event) => {
                if (
                  [
                    "ArrowUp",
                    "ArrowDown",
                    "Home",
                    "End",
                    "PageUp",
                    "PageDown",
                  ].includes(event.key)
                ) {
                  event.preventDefault();
                  const page = Math.max(
                    1,
                    Math.floor(
                      (grid.current?.clientHeight || 200) / rowHeight,
                    ) - 1,
                  );
                  const next = Math.max(
                    0,
                    Math.min(
                      rows.length - 1,
                      event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? rows.length - 1
                          : focused +
                            (event.key === "ArrowUp"
                              ? -1
                              : event.key === "ArrowDown"
                                ? 1
                                : event.key === "PageUp"
                                  ? -page
                                  : page),
                    ),
                  );
                  if (rows[next]) {
                    choose(rows[next], next);
                    virtual.scrollToIndex(next);
                  }
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  event.stopPropagation();
                  void prepare();
                } else if (
                  event.key === "Delete" &&
                  item &&
                  !item.active &&
                  !busy
                ) {
                  event.preventDefault();
                  setRemoving(item);
                }
              }}
            >
              {!rows.length && (
                <p className="empty-hint">
                  {busy ? t.loading : t.recoveryEmpty}
                </p>
              )}
              <div
                style={{ height: virtual.getTotalSize(), position: "relative" }}
              >
                {virtual.getVirtualItems().map((v) => {
                  const row = rows[v.index];
                  return (
                    <div
                      id={`recovery-row-${v.index}`}
                      key={row.key}
                      role="option"
                      aria-selected={selected === row.key}
                      className={`recovery-row ${selected === row.key ? "selected" : ""}`}
                      style={{
                        height: v.size,
                        transform: `translateY(${v.start}px)`,
                      }}
                      onClick={() => {
                        choose(row, v.index);
                        grid.current?.focus();
                      }}
                      onDoubleClick={() => {
                        if (selected === row.key) void prepare();
                      }}
                    >
                      {row.entry ? (
                        <FileIcon entry={row.entry} />
                      ) : (
                        <History size={16} />
                      )}
                      <span>
                        <strong>
                          {row.original
                            ? basename(row.original)
                            : t.recoveryUnknown}
                        </strong>
                        <small>{kindLabel(row)}</small>
                      </span>
                      <small>
                        {row.entry && !row.entry.isDir
                          ? size(row.entry.size)
                          : row.entry?.isDir
                            ? t.folder
                            : "—"}
                      </small>
                    </div>
                  );
                })}
              </div>
            </div>
            <section className="recovery-detail" aria-label={t.details}>
              {item ? (
                <>
                  <div className="recovery-detail-heading">
                    <strong>{kindLabel(item)}</strong>
                    <IconButton
                      title={
                        item.entry?.isDir ? t.recoveryOpenFolder : t.preview
                      }
                      shortcut="F3"
                      disabled={!item.entry || item.active || !!busy}
                      onClick={view}
                    >
                      {item.entry?.isDir ? (
                        <FolderOpen size={15} />
                      ) : (
                        <Eye size={15} />
                      )}
                    </IconButton>
                  </div>
                  <details className="recovery-paths">
                    <summary>{t.details}</summary>
                    <dl>
                      <dt>{t.recoveryOriginal}</dt>
                      <dd>{item.original || t.recoveryUnknown}</dd>
                      <dt>{t.recoverySaved}</dt>
                      <dd>{item.payload}</dd>
                      {item.created && (
                        <>
                          <dt>{t.created}</dt>
                          <dd>
                            {new Date(item.created * 1000).toLocaleString()}
                          </dd>
                        </>
                      )}
                    </dl>
                  </details>
                  {item.error && (
                    <p className="warning">
                      {!item.entry ? t.recoveryMissingHint : item.error}
                    </p>
                  )}
                  {item.entry?.isDir && item.kind !== "backup" && (
                    <p className="hint">{t.recoveryNested}</p>
                  )}
                  <label className="field">
                    <span>{t.recoveryName}</span>
                    <input
                      aria-label={t.recoveryName}
                      value={name}
                      disabled={!canRestore}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </label>
                  <Select
                    label={t.destination}
                    value={destination}
                    disabled={!canRestore}
                    options={[
                      { value: "saved", label: t.recoverySourceFolder },
                      ...(other && !other.source.startsWith("zip:")
                        ? [
                            {
                              value: "other",
                              label: `${t.recoveryOtherPane} · ${otherLabel || other.source}`,
                            },
                          ]
                        : []),
                    ]}
                    onChange={(value) => {
                      setDestination(value);
                      setFolder(
                        value === "other" && other ? other.path : item.folder,
                      );
                    }}
                  />
                  <label className="field">
                    <span>{t.recoveryFolder}</span>
                    <input
                      aria-label={t.recoveryFolder}
                      value={folder}
                      disabled={!canRestore}
                      onChange={(e) => setFolder(e.target.value)}
                    />
                  </label>
                  <label className="recovery-check">
                    <input
                      type="checkbox"
                      checked={replace}
                      disabled={!canRestore}
                      onChange={(e) => setReplace(e.target.checked)}
                    />
                    {t.recoveryReplace}
                  </label>
                </>
              ) : (
                <p className="hint">{t.recoveryEmpty}</p>
              )}
            </section>
          </div>
          {(busy === "scan" || busy === "plan") && (
            <div className="recovery-status" role="status">
              <LoaderCircle className="spin" size={14} />
              {busy === "plan" ? t.recoveryPreparing : t.loading}
              {busy === "plan" &&
                planProgress &&
                ` · ${planProgress.files} ${t.files} · ${size(planProgress.bytes)}`}
            </div>
          )}
          {(notice || progress?.limited || progress?.cancelled) && (
            <p className="hint" role="status">
              {notice ||
                (progress?.limited ? t.recoveryLimited : t.recoveryStopped)}
            </p>
          )}
          {progress?.errors.length ? (
            <details>
              <summary>
                {t.details} ({progress.errors.length})
              </summary>
              <pre>{progress.errors.join("\n")}</pre>
            </details>
          ) : null}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="recovery-footer">
            <span>
              F3 · {t.preview}　Enter · {t.recoveryReview}　F1 · {t.keyboard}
            </span>
            <div>
              <IconButton
                title={t.recoveryRemove}
                shortcut="Delete"
                disabled={!item || item.active || !!busy}
                onClick={() => setRemoving(item)}
              >
                <Trash2 size={14} />
              </IconButton>
              <button
                className="primary"
                disabled={!canRestore || !name.trim() || !folder.trim()}
                onClick={() => void prepare()}
                data-shortcut="Enter / Ctrl+Enter"
              >
                {t.recoveryReview}
              </button>
              <button onClick={onClose}>{t.close}</button>
            </div>
          </div>
        </div>
      </Modal>
      {preview && (
        <PreviewDialog
          t={t}
          location={{ source: location.source, path: preview.payload }}
          connection={preview.connection}
          onClose={() => setPreview(undefined)}
        />
      )}
      {help && <ShortcutsDialog t={t} onClose={() => setHelp(false)} />}
      {review && (
        <Modal
          title={t.recoveryReview}
          subtitle={`${label} → ${destination === "other" ? otherLabel || other?.source : label}`}
          closeLabel={t.close}
          onClose={() => {
            if (!busy) {
              setReview(undefined);
              release();
            }
          }}
          wide
        >
          <div
            className="recovery-review"
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                e.preventDefault();
                e.stopPropagation();
                void queue();
              }
            }}
          >
            <p className="hint">{t.recoveryKeep}</p>
            <div className="recovery-review-roots">
              <div>
                <small>{t.recoverySaved}</small>
                <strong>{item?.payload}</strong>
              </div>
              <div>
                <small>{t.recoveryFolder}</small>
                <strong>{review.summary.destination.path}</strong>
              </div>
            </div>
            {review.summary.checksumChanged && (
              <p className="warning">{t.recoveryChecksum}</p>
            )}
            <div className="recovery-counts">
              <span>
                {review.summary.files} {t.files} · {review.summary.folders}{" "}
                {t.folders} · {size(review.summary.bytes)}
              </span>
              <span>
                {t.compareCreate}:{" "}
                {review.summary.rows.length - review.summary.replace} ·{" "}
                {t.compareReplace}: {review.summary.replace}
              </span>
            </div>
            <div
              className="recovery-review-list"
              ref={reviewList}
              tabIndex={0}
              aria-label={t.recoveryReview}
              onKeyDown={(e) => {
                if (["Home", "End", "PageUp", "PageDown"].includes(e.key)) {
                  e.preventDefault();
                  const list = reviewList.current!;
                  if (e.key === "Home" || e.key === "End")
                    reviewVirtual.scrollToIndex(
                      e.key === "Home" ? 0 : review.summary.rows.length - 1,
                      { align: e.key === "Home" ? "start" : "end" },
                    );
                  else
                    list.scrollTop +=
                      (e.key === "PageUp" ? -1 : 1) * list.clientHeight;
                }
              }}
            >
              <div
                style={{
                  height: reviewVirtual.getTotalSize(),
                  position: "relative",
                }}
              >
                {reviewVirtual.getVirtualItems().map((v) => {
                  const row = review.summary.rows[v.index];
                  return (
                    <div
                      className="recovery-review-row"
                      key={row.path}
                      style={{
                        height: v.size,
                        transform: `translateY(${v.start}px)`,
                      }}
                    >
                      <span>
                        {row.replace ? t.compareReplace : t.compareCreate}
                      </span>
                      <code>{row.path}</code>
                      <small>{row.directory ? t.folder : size(row.size)}</small>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="modal-actions">
              <button
                disabled={!!busy}
                onClick={() => {
                  setReview(undefined);
                  release();
                }}
              >
                {t.cancel}
              </button>
              <button
                className="primary"
                disabled={!api.desktop || !!busy}
                onClick={() => void queue()}
                data-shortcut="Ctrl+Enter"
              >
                {t.restore}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {removing && (
        <Modal
          title={t.recoveryRemove}
          closeLabel={t.close}
          onClose={() => {
            if (!busy) setRemoving(undefined);
          }}
        >
          <div
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                e.preventDefault();
                e.stopPropagation();
                void queue(true);
              }
            }}
          >
            <p>{t.recoveryRemoveHint}</p>
            <pre className="recovery-remove-path">
              {removing.payload}
              {removing.record && `\n${removing.record}`}
            </pre>
            {!removing.entry && <p className="hint">{t.recoveryMissingHint}</p>}
            <div className="modal-actions">
              <button disabled={!!busy} onClick={() => setRemoving(undefined)}>
                {t.cancel}
              </button>
              <button
                className="danger"
                disabled={!api.desktop || !!busy}
                onClick={() => void queue(true)}
              >
                {t.delete}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
