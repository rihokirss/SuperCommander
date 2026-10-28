import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowLeft,
  ArrowRight,
  Eye,
  FilePenLine,
  FolderSync,
  LoaderCircle,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import * as api from "../api";
import { uid, size } from "../utils";
import {
  applyChoice,
  choicesFor,
  folderSelection,
  suggested,
  type ComparisonPolicy,
} from "../comparison";
import type {
  ComparisonChoice,
  ComparisonDirection,
  ComparisonOptions,
  ComparisonProgress,
  ComparisonResult,
  ComparisonRow,
  Location,
} from "../types";
import type { Text } from "../i18n";
import { FileIcon, IconButton, Modal } from "./Primitives";
import { Select } from "./Select";
import { PreviewDialog } from "./PreviewDialog";
import { TextWorkbench, type SaveDestination } from "./TextWorkbench";
import { ShortcutsDialog } from "./Dialogs";

export function ComparisonDialog({
  left,
  right,
  showHidden,
  t,
  onClose,
  onQueue,
  onReveal,
  onSaved,
  destinations,
  density,
  labels: rootLabels,
  initialSide,
}: {
  left: Location;
  right: Location;
  showHidden: boolean;
  t: Text;
  onClose: () => void;
  onQueue: (
    id: string,
    comparison: string,
    choices: ComparisonChoice[],
  ) => Promise<void>;
  onReveal: (side: number, location: Location) => void;
  onSaved: () => void;
  destinations: SaveDestination[];
  density: "comfortable" | "compact";
  labels: [string, string];
  initialSide: number;
}) {
  const [options, setOptions] = useState<ComparisonOptions>({
    content: api.desktop,
    recursive: true,
    showHidden,
    caseSensitive: true,
    exclude: "",
    maxEntries: 200000,
    timeTolerance: 2,
  });
  const [data, setData] = useState<ComparisonResult>();
  const [busy, setBusy] = useState(false),
    [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(""),
    [invalid, setInvalid] = useState(false);
  const [progress, setProgress] = useState<ComparisonProgress>();
  const [advanced, setAdvanced] = useState(false),
    [onlyDiff, setOnlyDiff] = useState(true);
  const [query, setQuery] = useState(""),
    [policy, setPolicy] = useState<ComparisonPolicy>("newer");
  const [choices, setChoices] = useState(
    new Map<number, ComparisonDirection>(),
  );
  const [focused, setFocused] = useState(0),
    [side, setSide] = useState(initialSide);
  const [review, setReview] = useState(false),
    [help, setHelp] = useState(false);
  const [document, setDocument] = useState<{
    row: ComparisonRow;
    side: number;
    mode: "view" | "edit";
    connection?: string | null;
    line?: number;
    column?: number;
  }>();
  const grid = useRef<HTMLDivElement>(null),
    wrapper = useRef<HTMLDivElement>(null);
  const filterInput = useRef<HTMLInputElement>(null),
    reviewList = useRef<HTMLDivElement>(null);
  const task = useRef<string | undefined>(undefined),
    resultId = useRef<string | undefined>(undefined);
  const syncTask = useRef<string | undefined>(undefined),
    alive = useRef(true);
  const rows = useMemo(
    () =>
      (data?.plan.rows || []).filter(
        (row) =>
          (!onlyDiff ||
            !["same", "same_metadata", "folder"].includes(row.status)) &&
          row.path.toLowerCase().includes(query.toLowerCase()),
      ),
    [data, onlyDiff, query],
  );
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => grid.current,
    estimateSize: () => (density === "compact" ? 32 : 40),
    overscan: 8,
  });
  const selected = data?.plan.rows.filter((row) => choices.has(row.id)) || [];
  const reviewVirtual = useVirtualizer({
    count: selected.length,
    getScrollElement: () => reviewList.current,
    estimateSize: () => 32,
    overscan: 6,
    enabled: review,
  });
  const visibleSelectable = rows.filter((row) => row.toLeft || row.toRight);
  const visibleSelected = visibleSelectable.filter((row) =>
    choices.has(row.id),
  ).length;
  const ready =
    !!data &&
    !busy &&
    !submitting &&
    !invalid &&
    !data.plan.progress.cancelled &&
    !data.plan.progress.limited;
  const labels: Record<string, string> = {
    folder: t.folder,
    folder_different: t.compareFolderDifferent,
    same: t.compareSame,
    same_metadata: t.compareSameMetadata,
    left_only: t.compareLeftOnly,
    right_only: t.compareRightOnly,
    left_newer: t.compareLeftNewer,
    right_newer: t.compareRightNewer,
    different: t.compareDifferent,
    conflict: t.compareBlocked,
    ambiguous: t.compareBlocked,
  };
  const groups = useMemo(
    () =>
      folderSelection(
        data?.plan.rows || [],
        choices,
        data?.plan.options.caseSensitive ?? true,
      ),
    [data, choices],
  );
  const allInRow = (row: ComparisonRow) => {
    const group = groups.get(row.id);
    return (
      ((!row.toLeft && !row.toRight) || choices.has(row.id)) &&
      (!group || group.total === group.selected) &&
      (choices.has(row.id) || !!group?.total)
    );
  };
  const canCopy = (row: ComparisonRow, direction: ComparisonDirection) =>
    direction === "left_to_right"
      ? row.toRight || !!groups.get(row.id)?.right
      : row.toLeft || !!groups.get(row.id)?.left;
  function cancel() {
    if (task.current && api.desktop)
      void api.command("cancel_search", { id: task.current }).catch(() => {});
  }
  function release() {
    if (resultId.current && api.desktop)
      void api
        .command("release_comparison", { id: resultId.current })
        .catch(() => {});
    resultId.current = undefined;
  }
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      cancel();
      release();
      if (syncTask.current && api.desktop)
        void api
          .command("cancel_job", { id: syncTask.current })
          .catch(() => {});
    };
  }, []);
  async function compare() {
    if (busy || submitting) return;
    if (
      !Number.isSafeInteger(options.maxEntries) ||
      options.maxEntries < 1 ||
      options.maxEntries > 1000000 ||
      !Number.isSafeInteger(options.timeTolerance) ||
      options.timeTolerance < 0 ||
      options.timeTolerance > 86400
    ) {
      setError(t.invalidComparisonOptions);
      return;
    }
    release();
    const id = uid();
    task.current = id;
    setBusy(true);
    setError("");
    setInvalid(false);
    setData(undefined);
    setProgress(undefined);
    setChoices(new Map());
    setFocused(0);
    try {
      const value = await api.compareFolders(
        id,
        left,
        right,
        options,
        (value) => {
          if (alive.current && task.current === id) setProgress(value);
        },
      );
      if (!alive.current || task.current !== id) {
        if (api.desktop)
          void api.command("release_comparison", { id }).catch(() => {});
        return;
      }
      resultId.current = value.id;
      setData(value);
      setChoices(choicesFor(value.plan.rows, policy));
      requestAnimationFrame(() => grid.current?.focus());
    } catch (e) {
      if (alive.current && task.current === id) {
        if (String(e).includes("Cancelled"))
          setProgress({
            scanned: 0,
            bytes: 0,
            side: 0,
            current: "",
            done: true,
            cancelled: true,
            limited: false,
            errors: [],
          });
        else setError(String(e));
      }
    } finally {
      if (alive.current && task.current === id) {
        task.current = undefined;
        setBusy(false);
      }
    }
  }
  function changeOptions(change: Partial<ComparisonOptions>) {
    setOptions((value) => ({ ...value, ...change }));
    if (data) setInvalid(true);
  }
  function setDirection(row: ComparisonRow, direction?: ComparisonDirection) {
    setChoices((previous) =>
      applyChoice(
        data?.plan.rows || [],
        previous,
        row,
        direction,
        data?.plan.options.caseSensitive ?? true,
      ),
    );
  }
  function toggle(row: ComparisonRow) {
    const key = (path: string) =>
      data?.plan.options.caseSensitive === false ? path.toLowerCase() : path;
    const all = allInRow(row),
      folder = (row.left || row.right)!.entry.isDir;
    const next = new Map(choices);
    for (const item of data?.plan.rows || []) {
      if (
        item.id !== row.id &&
        (!folder || !key(item.path).startsWith(key(row.path) + "/"))
      )
        continue;
      const fallback =
        side === 0 && item.toRight
          ? "left_to_right"
          : side === 1 && item.toLeft
            ? "right_to_left"
            : item.toRight
              ? "left_to_right"
              : item.toLeft
                ? "right_to_left"
                : undefined;
      const direction = suggested(item, policy) || fallback;
      if (all) next.delete(item.id);
      else if (direction) next.set(item.id, direction);
    }
    setChoices(next);
  }
  function selectVisible(selected: boolean) {
    if (!ready) return;
    const next = new Map(choices);
    for (const row of visibleSelectable) {
      if (!selected) next.delete(row.id);
      else {
        const direction =
          suggested(row, policy) ||
          (side === 0 && row.toRight
            ? "left_to_right"
            : side === 1 && row.toLeft
              ? "right_to_left"
              : row.toRight
                ? "left_to_right"
                : "right_to_left");
        next.set(row.id, direction);
      }
    }
    setChoices(next);
  }
  async function reveal(row: ComparisonRow) {
    const node = side === 0 ? row.left : row.right;
    if (!node) return;
    const location = { ...(side === 0 ? left : right), path: node.entry.path };
    try {
      const info = await api.properties(location, node.entry);
      if (
        info.connection !==
        (side === 0 ? data?.plan.left.connection : data?.plan.right.connection)
      )
        throw new Error(t.comparisonConnectionChanged);
      if (!info.file.isDir) throw new Error(t.compareChanged);
      if (alive.current) onReveal(side, location);
    } catch (error) {
      if (alive.current) setError(String(error));
    }
  }
  function view(row: ComparisonRow, mode: "view" | "edit" = "view") {
    const node = side === 0 ? row.left : row.right;
    if (
      !node ||
      node.entry.isDir ||
      (mode === "edit" && (side === 0 ? left : right).source.startsWith("zip:"))
    )
      return;
    setDocument({
      row,
      side,
      mode,
      connection:
        side === 0 ? data?.plan.left.connection : data?.plan.right.connection,
    });
  }
  async function queue() {
    if (
      !api.desktop ||
      !data ||
      !ready ||
      !selected.length ||
      submitting ||
      syncTask.current
    )
      return;
    const id = uid();
    syncTask.current = id;
    setSubmitting(true);
    setError("");
    try {
      await onQueue(
        id,
        data.id,
        selected.map((row) => ({
          id: row.id,
          direction: choices.get(row.id)!,
        })),
      );
      syncTask.current = undefined;
      if (alive.current) onClose();
    } catch (e) {
      if (alive.current) {
        setError(String(e).includes("Cancelled") ? "" : String(e));
        setReview(false);
        if (!String(e).includes("Cancelled")) setInvalid(true);
      }
    } finally {
      syncTask.current = undefined;
      if (alive.current) setSubmitting(false);
    }
  }
  function cancelPreparation() {
    if (syncTask.current && api.desktop)
      void api.command("cancel_job", { id: syncTask.current }).catch(() => {});
    setReview(false);
  }
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const top = window.document.querySelectorAll(
        '[role="dialog"][aria-modal="true"]',
      );
      if (
        review &&
        top[top.length - 1]?.getAttribute("aria-label") === t.compareReview &&
        (event.ctrlKey || event.metaKey) &&
        event.key === "Enter"
      ) {
        event.preventDefault();
        if (!event.repeat) void queue();
        return;
      }
      if (
        top[top.length - 1] !== wrapper.current?.closest('[role="dialog"]') ||
        (event.altKey && event.ctrlKey)
      )
        return;
      const ctrl = event.ctrlKey || event.metaKey;
      if (ctrl && event.key.toLowerCase() === "f") {
        event.preventDefault();
        filterInput.current?.focus();
        filterInput.current?.select();
        return;
      }
      if (
        ctrl &&
        event.key.toLowerCase() === "a" &&
        !(event.target as HTMLElement).closest("input,textarea,select")
      ) {
        event.preventDefault();
        selectVisible(!event.shiftKey);
        return;
      }
      if ((ctrl && event.key.toLowerCase() === "r") || event.key === "F5") {
        event.preventDefault();
        void compare();
        return;
      }
      if (event.key === "F1") {
        event.preventDefault();
        setHelp(true);
        return;
      }
      if (ctrl && event.key === "Enter" && ready && selected.length) {
        event.preventDefault();
        setReview(true);
        return;
      }
    };
    window.document.addEventListener("keydown", key);
    return () => window.document.removeEventListener("keydown", key);
  });
  const current = rows[Math.min(focused, rows.length - 1)];
  const reviewCounts = selected.reduce(
    (total, row) => {
      const direction = choices.get(row.id)!;
      const source = direction === "left_to_right" ? row.left! : row.right!;
      const target = direction === "left_to_right" ? row.right : row.left;
      total.bytes += source.entry.isDir ? 0 : source.entry.size;
      if (target) total.replace++;
      else total.create++;
      return total;
    },
    { bytes: 0, create: 0, replace: 0 },
  );
  return (
    <>
      <Modal
        title={t.compareDirectories}
        subtitle={t.compareHint}
        closeLabel={t.close}
        onClose={onClose}
        full
      >
        <div className="comparison-workbench" ref={wrapper}>
          <div className="comparison-roots">
            {[left, right].map((location, i) => (
              <button
                type="button"
                key={i}
                className={side === i ? "chosen" : ""}
                onClick={() => setSide(i)}
                data-tooltip={t.comparePreviewSide}
              >
                <span>
                  {i === 0 ? t.leftSide : t.rightSide}
                  {` · ${rootLabels[i]}`}
                  {data &&
                  !(i === 0 ? data.plan.left : data.plan.right).writable
                    ? ` · ${t.readOnly}`
                    : ""}
                </span>
                <strong title={`${rootLabels[i]} · ${location.path}`}>
                  {location.path}
                </strong>
              </button>
            ))}
          </div>
          <form
            className="comparison-form"
            onSubmit={(event) => {
              event.preventDefault();
              void compare();
            }}
          >
            <fieldset disabled={busy || submitting}>
              <Select
                label={t.comparisonMethod}
                value={options.content ? "content" : "metadata"}
                options={[
                  { value: "content", label: t.compareContent },
                  { value: "metadata", label: t.compareMetadata },
                ]}
                onChange={(value) =>
                  changeOptions({ content: value === "content" })
                }
              />
              <label>
                <input
                  type="checkbox"
                  checked={options.recursive}
                  onChange={(event) =>
                    changeOptions({ recursive: event.target.checked })
                  }
                />
                {t.recursiveSearch}
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={options.showHidden}
                  onChange={(event) =>
                    changeOptions({ showHidden: event.target.checked })
                  }
                />
                {t.hidden}
              </label>
              <button
                type="button"
                className={advanced ? "pressed" : ""}
                onClick={() => setAdvanced((value) => !value)}
              >
                <SlidersHorizontal size={14} />
                {t.details}
              </button>
            </fieldset>
            {busy ? (
              <button type="button" onClick={cancel}>
                <X size={14} />
                {t.cancel}
              </button>
            ) : (
              <button className="primary" disabled={submitting}>
                <FolderSync size={14} />
                {t.compareStart}
                <kbd>F5</kbd>
              </button>
            )}
          </form>
          {advanced && (
            <fieldset
              className="comparison-advanced"
              disabled={busy || submitting}
            >
              <label className="field">
                {t.compareExclude}
                <input
                  value={options.exclude}
                  placeholder="node_modules; .git; *.tmp"
                  onChange={(e) => changeOptions({ exclude: e.target.value })}
                />
              </label>
              <label className="field">
                {t.compareTolerance}
                <input
                  type="number"
                  min={0}
                  max={86400}
                  value={options.timeTolerance}
                  onChange={(e) =>
                    changeOptions({ timeTolerance: Number(e.target.value) })
                  }
                />
              </label>
              <label className="field">
                {t.compareLimit}
                <input
                  type="number"
                  min={1}
                  max={1000000}
                  value={options.maxEntries}
                  onChange={(e) =>
                    changeOptions({ maxEntries: Number(e.target.value) })
                  }
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={options.caseSensitive}
                  onChange={(e) =>
                    changeOptions({ caseSensitive: e.target.checked })
                  }
                />
                {t.compareCase}
              </label>
            </fieldset>
          )}
          <div className="comparison-tools">
            <div className="comparison-filter">
              <Search size={14} />
              <input
                ref={filterInput}
                aria-label={t.filterDifferences}
                placeholder={t.filterDifferences}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setFocused(0);
                }}
              />
            </div>
            <label>
              <input
                type="checkbox"
                checked={onlyDiff}
                onChange={(e) => {
                  setOnlyDiff(e.target.checked);
                  setFocused(0);
                }}
              />
              {t.compareOnlyDifferences}
            </label>
            <Select
              label={t.comparisonPolicy}
              disabled={busy || submitting}
              value={policy}
              options={[
                { value: "newer", label: t.compareNewer },
                { value: "left", label: t.copyLeftRight },
                { value: "right", label: t.copyRightLeft },
                { value: "manual", label: t.manualDirections },
              ]}
              onChange={(value) => {
                setPolicy(value as ComparisonPolicy);
                setChoices(
                  choicesFor(data?.plan.rows || [], value as ComparisonPolicy),
                );
              }}
            />
            <button
              onClick={() => setChoices(new Map())}
              disabled={!choices.size}
            >
              {t.clearSelection}
            </button>
          </div>
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          {invalid && (
            <p className="comparison-notice" role="status">
              {t.compareChanged}
            </p>
          )}
          {(data?.plan.progress.cancelled || progress?.cancelled) && (
            <p className="comparison-notice" role="status">
              {t.compareStopped}
            </p>
          )}
          {data?.plan.progress.limited && (
            <p className="comparison-notice" role="status">
              {t.compareLimited}
            </p>
          )}
          {!!data?.plan.progress.errors.length && (
            <details className="comparison-errors">
              <summary>
                {t.details} ({data.plan.progress.errors.length})
              </summary>
              <pre>{data.plan.progress.errors.join("\n")}</pre>
            </details>
          )}
          <div className="comparison-columns">
            <input
              type="checkbox"
              aria-label={t.compareSelectedVisible}
              disabled={!ready || !visibleSelectable.length}
              checked={
                !!visibleSelectable.length &&
                visibleSelected === visibleSelectable.length
              }
              ref={(element) => {
                if (element)
                  element.indeterminate =
                    visibleSelected > 0 &&
                    visibleSelected < visibleSelectable.length;
              }}
              onChange={(event) => selectVisible(event.target.checked)}
            />
            <span>{t.name}</span>
            <span>{t.leftSide}</span>
            <span>{t.actions}</span>
            <span>{t.rightSide}</span>
          </div>
          <div
            ref={grid}
            className="comparison-grid"
            role="listbox"
            aria-label={t.compareDirectories}
            aria-multiselectable="true"
            tabIndex={0}
            aria-activedescendant={
              current ? `compare-${current.id}` : undefined
            }
            onKeyDown={(event) => {
              if ((event.target as HTMLElement).closest("button,input")) return;
              const row = rows[Math.min(focused, rows.length - 1)];
              const keys = [
                "ArrowUp",
                "ArrowDown",
                "Home",
                "End",
                "PageUp",
                "PageDown",
              ];
              if (keys.includes(event.key)) {
                event.preventDefault();
                const page = Math.max(
                  1,
                  Math.floor(
                    (grid.current?.clientHeight || 420) /
                      (density === "compact" ? 32 : 40),
                  ) - 1,
                );
                const next =
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
                              : page);
                const index = Math.max(0, Math.min(rows.length - 1, next));
                setFocused(index);
                virtual.scrollToIndex(index);
                return;
              }
              if (!row) return;
              if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                event.preventDefault();
                if (event.altKey)
                  setDirection(
                    row,
                    event.key === "ArrowRight" && canCopy(row, "left_to_right")
                      ? "left_to_right"
                      : event.key === "ArrowLeft" &&
                          canCopy(row, "right_to_left")
                        ? "right_to_left"
                        : undefined,
                  );
                else setSide(event.key === "ArrowLeft" ? 0 : 1);
              } else if (event.key === " " || event.key === "Insert") {
                event.preventDefault();
                toggle(row);
                if (event.key === "Insert") {
                  const next = Math.min(rows.length - 1, focused + 1);
                  setFocused(next);
                  virtual.scrollToIndex(next);
                }
              } else if (event.key === "Delete" || event.key === "Backspace") {
                event.preventDefault();
                setDirection(row);
              } else if (
                event.key === "F3" ||
                (event.key === "Enter" && !event.ctrlKey && !event.metaKey)
              ) {
                event.preventDefault();
                event.stopPropagation();
                const node = side === 0 ? row.left : row.right;
                if (node?.entry.isDir) void reveal(row);
                else view(row);
              } else if (event.key === "F4") {
                event.preventDefault();
                event.stopPropagation();
                view(row, "edit");
              }
            }}
          >
            {!data && !busy ? (
              <div className="empty-state">
                <FolderSync size={28} />
                <p>{t.compareHint}</p>
              </div>
            ) : busy ? (
              <div className="empty-state">
                <LoaderCircle className="spin" />
                <p>{progress?.current || t.compareDirectories}</p>
                <small>
                  {(progress?.scanned || 0).toLocaleString()} {t.items} ·{" "}
                  {size(progress?.bytes || 0)}
                </small>
              </div>
            ) : !rows.length ? (
              <div className="empty-state">
                <FolderSync size={26} />
                <p>{t.compareEmpty}</p>
              </div>
            ) : (
              <div
                style={{ height: virtual.getTotalSize(), position: "relative" }}
              >
                {virtual.getVirtualItems().map((item) => {
                  const row = rows[item.index],
                    direction = choices.get(row.id),
                    node = side === 0 ? row.left : row.right;
                  const group = groups.get(row.id);
                  const selected = allInRow(row);
                  const partial =
                    !selected && (!!direction || !!group?.selected);
                  return (
                    <div
                      key={row.id}
                      id={`compare-${row.id}`}
                      className={`comparison-row ${focused === item.index ? "focused" : ""} ${selected || partial ? "selected" : ""} ${row.blocked ? "blocked" : ""}`}
                      role="option"
                      aria-selected={selected || partial}
                      data-path={row.path}
                      style={{
                        position: "absolute",
                        transform: `translateY(${item.start}px)`,
                        height: item.size,
                        width: "100%",
                      }}
                      onClick={() => {
                        setFocused(item.index);
                        grid.current?.focus();
                      }}
                      onDoubleClick={() => {
                        if (node?.entry.isDir) void reveal(row);
                        else view(row);
                      }}
                    >
                      <input
                        type="checkbox"
                        aria-label={`${t.selection}: ${row.path}`}
                        checked={selected}
                        ref={(element) => {
                          if (element) element.indeterminate = partial;
                        }}
                        disabled={
                          !ready ||
                          (!row.toLeft && !row.toRight && !group?.total)
                        }
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => toggle(row)}
                      />
                      <div
                        className="comparison-path"
                        title={row.blocked || row.path}
                      >
                        <FileIcon entry={(row.left || row.right)!.entry} />
                        <div>
                          <strong>{row.path}</strong>
                          <small>{labels[row.status] || row.status}</small>
                        </div>
                      </div>
                      {[0, 1].map((column) => {
                        const entry = (column === 0 ? row.left : row.right)
                          ?.entry;
                        return (
                          <div
                            key={column}
                            className={`comparison-meta side-${column} ${side === column ? "active-side" : ""}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              setSide(column);
                              setFocused(item.index);
                              grid.current?.focus();
                            }}
                          >
                            {entry ? (
                              <>
                                <span>
                                  {entry.isDir ? t.folder : size(entry.size)}
                                </span>
                                <small>
                                  {entry.modified
                                    ? new Date(
                                        entry.modified * 1000,
                                      ).toLocaleString()
                                    : "—"}
                                </small>
                              </>
                            ) : (
                              <span>—</span>
                            )}
                          </div>
                        );
                      })}
                      <div
                        className="comparison-arrows"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <IconButton
                          title={t.copyRightLeft}
                          shortcut="Alt+←"
                          disabled={!ready || !canCopy(row, "right_to_left")}
                          className={
                            direction === "right_to_left" ? "pressed" : ""
                          }
                          onClick={() =>
                            setDirection(
                              row,
                              direction === "right_to_left"
                                ? undefined
                                : "right_to_left",
                            )
                          }
                        >
                          <ArrowLeft size={14} />
                        </IconButton>
                        <IconButton
                          title={t.copyLeftRight}
                          shortcut="Alt+→"
                          disabled={!ready || !canCopy(row, "left_to_right")}
                          className={
                            direction === "left_to_right" ? "pressed" : ""
                          }
                          onClick={() =>
                            setDirection(
                              row,
                              direction === "left_to_right"
                                ? undefined
                                : "left_to_right",
                            )
                          }
                        >
                          <ArrowRight size={14} />
                        </IconButton>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <div className="comparison-summary">
            <span>
              {choices.size.toLocaleString()} {t.selected} ·{" "}
              {rows.length.toLocaleString()} /{" "}
              {data?.plan.rows.length.toLocaleString() || 0} {t.items}
            </span>
            <small>{t.compareScopeHint}</small>
          </div>
          <footer className="comparison-footer">
            <button
              disabled={
                !current ||
                (side === 0 ? current.left : current.right)?.entry.isDir ||
                !(side === 0 ? current.left : current.right)
              }
              onClick={() => current && view(current)}
            >
              <Eye size={14} />
              <kbd>F3</kbd>
              {t.view}
            </button>
            <button
              disabled={
                !current ||
                !(side === 0 ? current.left : current.right) ||
                (side === 0 ? current.left : current.right)?.entry.isDir ||
                (side === 0 ? left : right).source.startsWith("zip:")
              }
              onClick={() => current && view(current, "edit")}
            >
              <FilePenLine size={14} />
              <kbd>F4</kbd>
              {t.edit}
            </button>
            <button onClick={() => setHelp(true)}>
              <kbd>F1</kbd>
              {t.keyboard}
            </button>
            <button
              className="primary"
              disabled={!ready || !selected.length || submitting}
              onClick={() => setReview(true)}
            >
              <FolderSync size={14} />
              {t.compareReview}
              <span>{selected.length}</span>
              <kbd>Ctrl+Enter</kbd>
            </button>
          </footer>
        </div>
      </Modal>
      {review && (
        <Modal
          title={t.compareReview}
          subtitle={`${selected.length} ${t.items} · ${size(reviewCounts.bytes)}`}
          closeLabel={t.cancel}
          onClose={() => {
            cancelPreparation();
          }}
        >
          <div className="comparison-review-roots">
            {[left, right].map((location, side) => (
              <div key={side}>
                <span>
                  {side === 0 ? t.leftSide : t.rightSide} · {rootLabels[side]}
                </span>
                <strong title={location.path}>{location.path}</strong>
              </div>
            ))}
          </div>
          <div className="comparison-review-counts">
            <span>
              {t.compareCreate}
              <strong>{reviewCounts.create}</strong>
            </span>
            <span>
              {t.compareReplace}
              <strong>{reviewCounts.replace}</strong>
            </span>
          </div>
          <p className="helper">{t.compareBackupHint}</p>
          <div
            className="comparison-review-list"
            ref={reviewList}
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === "Home" || event.key === "End") {
                event.preventDefault();
                reviewVirtual.scrollToIndex(
                  event.key === "Home" ? 0 : selected.length - 1,
                  { align: event.key === "Home" ? "start" : "end" },
                );
              } else if (
                ["PageUp", "PageDown", "ArrowUp", "ArrowDown"].includes(
                  event.key,
                )
              ) {
                event.preventDefault();
                const node = reviewList.current;
                if (node)
                  reviewVirtual.scrollToOffset(
                    node.scrollTop +
                      (event.key.startsWith("Page") ? node.clientHeight : 32) *
                        (["PageUp", "ArrowUp"].includes(event.key) ? -1 : 1),
                  );
              }
            }}
          >
            <div
              style={{
                height: reviewVirtual.getTotalSize(),
                position: "relative",
              }}
            >
              {reviewVirtual.getVirtualItems().map((item) => {
                const row = selected[item.index];
                return (
                  <div
                    className="comparison-review-row"
                    key={row.id}
                    data-index={item.index}
                    ref={reviewVirtual.measureElement}
                    style={{
                      position: "absolute",
                      width: "100%",
                      transform: `translateY(${item.start}px)`,
                    }}
                  >
                    <span>
                      {choices.get(row.id) === "left_to_right" ? "→" : "←"}
                    </span>
                    <span>{row.path}</span>
                  </div>
                );
              })}
            </div>
          </div>
          <footer className="modal-actions">
            <button onClick={cancelPreparation}>{t.cancel}</button>
            <button
              className="primary"
              disabled={submitting || !api.desktop}
              onClick={() => void queue()}
            >
              {submitting ? (
                <LoaderCircle size={14} className="spin" />
              ) : (
                <FolderSync size={14} />
              )}{" "}
              {t.synchronize} {selected.length}
            </button>
          </footer>
        </Modal>
      )}
      {document &&
        (() => {
          const node = (
            document.side === 0 ? document.row.left : document.row.right
          )!;
          const location = {
            ...(document.side === 0 ? left : right),
            path: node.entry.path,
          };
          return document.mode === "view" ? (
            <PreviewDialog
              location={location}
              t={t}
              onClose={() => setDocument(undefined)}
              connection={document.connection}
              onEdit={
                location.source.startsWith("zip:")
                  ? undefined
                  : (line, column, connection) =>
                      setDocument({
                        ...document,
                        mode: "edit",
                        line,
                        column,
                        connection,
                      })
              }
            />
          ) : (
            <TextWorkbench
              location={location}
              t={t}
              editable
              connection={document.connection}
              initialLine={document.line}
              initialColumn={document.column}
              destinations={destinations}
              onClose={() => setDocument(undefined)}
              onSaved={() => {
                setInvalid(true);
                onSaved();
              }}
            />
          );
        })()}
      {help && <ShortcutsDialog t={t} onClose={() => setHelp(false)} />}
    </>
  );
}
