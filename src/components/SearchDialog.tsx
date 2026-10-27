import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowRight,
  Eye,
  FilePenLine,
  LoaderCircle,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import * as api from "../api";
import { uid } from "../utils";
import { FileIcon, Modal } from "./Primitives";
import { Select } from "./Select";
import { PreviewDialog } from "./PreviewDialog";
import { TextWorkbench, type SaveDestination } from "./TextWorkbench";
import { ShortcutsDialog } from "./Dialogs";
import type { Location, SearchBatch, SearchFilter, SearchHit } from "../types";
import type { Text } from "../i18n";

export type SearchAction = "go" | "view" | "edit" | "other";
export function SearchDialog({
  location,
  t,
  showHidden,
  onClose,
  onAction,
  destinations,
  onSaved,
}: {
  location: Location;
  t: Text;
  showHidden: boolean;
  onClose: () => void;
  onAction: (
    hit: SearchHit,
    action: SearchAction,
    connection: string | null,
  ) => Promise<void>;
  destinations: SaveDestination[];
  onSaved: () => void;
}) {
  const [document, setDocument] = useState<{
    hit: SearchHit;
    mode: "view" | "edit";
    connection: string | null;
    line: number;
    column: number;
  }>();
  const [help, setHelp] = useState(false);
  const [query, setQuery] = useState(""),
    [content, setContent] = useState("");
  const [mode, setMode] = useState<SearchFilter["nameMode"]>("contains");
  const [kind, setKind] = useState<SearchFilter["kind"]>("all");
  const [recursive, setRecursive] = useState(true),
    [hidden, setHidden] = useState(showHidden);
  const [sensitive, setSensitive] = useState(false),
    [regex, setRegex] = useState(false),
    [whole, setWhole] = useState(false);
  const [exclude, setExclude] = useState(""),
    [limit, setLimit] = useState("20000");
  const [min, setMin] = useState(""),
    [max, setMax] = useState(""),
    [after, setAfter] = useState(""),
    [before, setBefore] = useState("");
  const [advanced, setAdvanced] = useState(false),
    [busy, setBusy] = useState(false),
    [opening, setOpening] = useState(false);
  const [error, setError] = useState(""),
    [stats, setStats] = useState<SearchBatch>();
  const [selected, setSelected] = useState(0),
    [, render] = useState(0);
  const hits = useRef<SearchHit[]>([]),
    latest = useRef<SearchBatch | undefined>(undefined);
  const task = useRef<string | undefined>(undefined),
    running = useRef(false),
    alive = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scroll = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [contentRows, setContentRows] = useState(false);
  const virtual = useVirtualizer({
    count: hits.current.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => (contentRows ? 68 : 48),
    overscan: 8,
  });
  useEffect(() => {
    virtual.measure();
  }, [contentRows]);
  useEffect(() => {
    alive.current = true;
    const focus = requestAnimationFrame(() => input.current?.focus());
    return () => {
      cancelAnimationFrame(focus);
      alive.current = false;
      clearTimeout(timer.current);
      if (task.current && api.desktop)
        void api.command("cancel_search", { id: task.current }).catch(() => {});
    };
  }, []);
  function flush() {
    clearTimeout(timer.current);
    timer.current = undefined;
    if (alive.current) {
      setStats(latest.current);
      render((value) => value + 1);
    }
  }
  async function start() {
    if (running.current) return;
    const maxResults = Number(limit);
    if (
      !Number.isInteger(maxResults) ||
      maxResults < 1 ||
      maxResults > 100000 ||
      (min && max && Number(min) > Number(max)) ||
      (after && before && after > before)
    ) {
      setError(t.invalidSearchRange);
      return;
    }
    const id = uid();
    task.current = id;
    running.current = true;
    hits.current = [];
    latest.current = undefined;
    setStats(undefined);
    setSelected(0);
    setError("");
    setBusy(true);
    setContentRows(!!content);
    flush();
    try {
      await api.search(
        id,
        location,
        {
          query,
          content,
          nameMode: mode,
          kind,
          recursive,
          showHidden: hidden,
          caseSensitive: sensitive,
          contentRegex: regex,
          wholeWord: whole,
          exclude,
          maxResults,
          minSize: min ? Number(min) : undefined,
          maxSize: max ? Number(max) : undefined,
          after: after
            ? new Date(`${after}T00:00:00`).getTime() / 1000
            : undefined,
          before: before
            ? new Date(`${before}T23:59:59`).getTime() / 1000
            : undefined,
        },
        (batch) => {
          if (!alive.current || task.current !== id) return;
          hits.current.push(...batch.matches);
          latest.current = batch;
          if (batch.done) {
            flush();
            setBusy(false);
          } else if (!timer.current) timer.current = setTimeout(flush, 80);
        },
      );
    } catch (error) {
      if (alive.current && task.current === id) setError(String(error));
    } finally {
      if (task.current === id) {
        running.current = false;
        if (alive.current) {
          flush();
          setBusy(false);
        }
      }
    }
  }
  async function open(action: SearchAction) {
    const hit = hits.current[selected];
    if (
      !hit ||
      opening ||
      ((action === "view" || action === "edit") && hit.entry.isDir)
    )
      return;
    if (action === "edit" && location.source.startsWith("zip:")) {
      setError(t.readOnly);
      return;
    }
    setOpening(true);
    try {
      await onAction(hit, action, latest.current?.connection || null);
      if (alive.current && (action === "view" || action === "edit"))
        setDocument({
          hit,
          mode: action,
          connection: latest.current?.connection || null,
          line: hit.line || 1,
          column: hit.column || 1,
        });
    } catch (error) {
      if (alive.current) setError(String(error));
    } finally {
      if (alive.current) setOpening(false);
    }
  }
  function select(index: number) {
    const next = Math.max(0, Math.min(hits.current.length - 1, index));
    setSelected(next);
    virtual.scrollToIndex(next, { align: "auto" });
  }
  const current = hits.current[selected];
  const skip = (stats?.skippedBinary || 0) + (stats?.skippedLongLines || 0);
  return (
    <>
      <Modal
        closeLabel={t.close}
        title={t.search}
        subtitle={`${t.searchIn} · ${location.path}`}
        onClose={onClose}
        wide
      >
        <div
          className="search-workbench"
          onKeyDown={(event) => {
            if (
              event.altKey ||
              event.metaKey ||
              window.document.querySelector('[data-select-open="true"]')
            )
              return;
            if (event.key === "F1") {
              event.preventDefault();
              setHelp(true);
            } else if (event.key === "F3" || event.key === "F4") {
              event.preventDefault();
              void open(event.key === "F3" ? "view" : "edit");
            } else if (event.key === "Enter" && event.ctrlKey) {
              event.preventDefault();
              void open("other");
            } else if (
              event.key === "ArrowDown" &&
              !(event.target as HTMLElement).closest(".search-results") &&
              hits.current.length
            ) {
              event.preventDefault();
              scroll.current?.focus();
            }
          }}
        >
          <form
            className="search-form"
            onSubmit={(event) => {
              event.preventDefault();
              void start();
            }}
          >
            <fieldset disabled={busy || opening}>
              <div className="search-name-row">
                <Select
                  label={t.nameMatchMode}
                  value={mode || "contains"}
                  options={[
                    { value: "contains", label: t.nameContains },
                    { value: "glob", label: t.filenameMasks },
                    { value: "regex", label: t.regex },
                  ]}
                  onChange={(value) =>
                    setMode(value as SearchFilter["nameMode"])
                  }
                />
                <input
                  ref={input}
                  autoFocus
                  aria-label={mode === "contains" ? t.query : t.filenamePattern}
                  placeholder={mode === "glob" ? "*.rs;*.toml" : t.query}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                <button className="primary" type="submit">
                  <Search size={14} />
                  {t.search}
                </button>
              </div>
              <label className="search-content-row">
                <span>{t.containingText}</span>
                <input
                  aria-label={t.containingText}
                  placeholder={t.optionalText}
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                />
              </label>
              <button
                type="button"
                className="search-filter-toggle"
                aria-expanded={advanced}
                onClick={() => setAdvanced((value) => !value)}
              >
                <SlidersHorizontal size={13} />
                {t.details}
              </button>
              {advanced && (
                <div className="search-advanced">
                  <div className="search-checks">
                    {[
                      [t.recursiveSearch, recursive, setRecursive],
                      [t.hidden, hidden, setHidden],
                      [t.matchCase, sensitive, setSensitive],
                      [t.contentRegex, regex, setRegex],
                      [t.wholeWord, whole, setWhole],
                    ].map(([label, checked, change]) => (
                      <label key={label as string}>
                        <input
                          type="checkbox"
                          checked={checked as boolean}
                          onChange={(event) =>
                            (change as (value: boolean) => void)(
                              event.target.checked,
                            )
                          }
                        />
                        {label as string}
                      </label>
                    ))}
                  </div>
                  <div className="form-grid search-filters">
                    <label className="field">
                      {t.excludeMasks}
                      <input
                        value={exclude}
                        placeholder="node_modules;.git;*.tmp"
                        onChange={(event) => setExclude(event.target.value)}
                      />
                    </label>
                    <label className="field">
                      {t.resultLimit}
                      <input
                        type="number"
                        min={1}
                        max={100000}
                        value={limit}
                        onChange={(event) => setLimit(event.target.value)}
                        required
                      />
                    </label>
                    <Select
                      label={t.itemType}
                      value={kind || "all"}
                      options={[
                        { value: "all", label: t.allItems },
                        { value: "files", label: t.files },
                        { value: "folders", label: t.folders },
                      ]}
                      onChange={(value) =>
                        setKind(value as SearchFilter["kind"])
                      }
                    />
                    <label className="field">
                      {t.minSize}
                      <input
                        type="number"
                        min={0}
                        value={min}
                        onChange={(event) => setMin(event.target.value)}
                      />
                    </label>
                    <label className="field">
                      {t.maxSize}
                      <input
                        type="number"
                        min={min || 0}
                        value={max}
                        onChange={(event) => setMax(event.target.value)}
                      />
                    </label>
                    <label className="field">
                      {t.afterDate}
                      <input
                        type="date"
                        value={after}
                        onChange={(event) => setAfter(event.target.value)}
                      />
                    </label>
                    <label className="field">
                      {t.beforeDate}
                      <input
                        type="date"
                        min={after}
                        value={before}
                        onChange={(event) => setBefore(event.target.value)}
                      />
                    </label>
                  </div>
                </div>
              )}
            </fieldset>
          </form>
          <div className="search-summary" role="status">
            <span>
              {(stats?.found || 0).toLocaleString()}{" "}
              {t.searchResults.toLowerCase()}
              {stats
                ? ` · ${stats.scanned.toLocaleString()} ${t.checkedItems}`
                : ""}
            </span>
            {busy ? (
              <button
                onClick={() =>
                  task.current &&
                  void api
                    .command("cancel_search", { id: task.current })
                    .catch((error) => setError(String(error)))
                }
              >
                <LoaderCircle size={12} className="spin" />
                {t.stopSearch}
              </button>
            ) : (
              <span>
                {stats?.cancelled
                  ? t.cancelled
                  : stats?.limited
                    ? t.searchLimitReached
                    : ""}
              </span>
            )}
          </div>
          <div
            ref={scroll}
            className="search-results"
            role="listbox"
            aria-label={t.searchResults}
            tabIndex={0}
            aria-activedescendant={
              current ? `search-hit-${selected}` : undefined
            }
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
                event.stopPropagation();
                const page = Math.max(
                  1,
                  Math.floor(
                    (scroll.current?.clientHeight || 240) /
                      (contentRows ? 68 : 48),
                  ),
                );
                select(
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? hits.current.length - 1
                      : selected +
                        (event.key === "ArrowUp"
                          ? -1
                          : event.key === "ArrowDown"
                            ? 1
                            : event.key === "PageUp"
                              ? -page
                              : page),
                );
              } else if (event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                void open(event.ctrlKey ? "other" : "go");
              }
            }}
          >
            <div
              style={{ height: virtual.getTotalSize(), position: "relative" }}
            >
              {virtual.getVirtualItems().map((row) => {
                const hit = hits.current[row.index];
                return (
                  <button
                    key={hit.entry.path}
                    id={`search-hit-${row.index}`}
                    role="option"
                    aria-selected={selected === row.index}
                    tabIndex={-1}
                    className={`search-result ${selected === row.index ? "selected" : ""} ${hit.preview ? "with-preview" : ""}`}
                    style={{
                      transform: `translateY(${row.start}px)`,
                      height: hit.preview ? 68 : 48,
                    }}
                    onClick={() => {
                      setSelected(row.index);
                      scroll.current?.focus();
                    }}
                    onDoubleClick={() => void open("go")}
                  >
                    <FileIcon entry={hit.entry} />
                    <span>
                      <strong>
                        {hit.entry.name}
                        {hit.line && (
                          <em>
                            :{hit.line}:{hit.column}
                          </em>
                        )}
                      </strong>
                      <small>{hit.entry.path}</small>
                      {hit.preview !== null && (
                        <code>
                          {hit.preview.slice(0, hit.start)}
                          <mark>{hit.preview.slice(hit.start, hit.end)}</mark>
                          {hit.preview.slice(hit.end)}
                        </code>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
            {!busy && !hits.current.length && (
              <div className="empty-state">
                <Search size={26} />
                <p>{t.noResults}</p>
              </div>
            )}
          </div>
          {!!skip && (
            <p className="helper search-skip">
              {t.skippedText}: {stats?.skippedBinary || 0} · {t.longTextLines}:{" "}
              {stats?.skippedLongLines || 0}
            </p>
          )}
          {(error || !!stats?.errorCount) && (
            <details className="search-errors" role="alert" open>
              <summary className="inline-error">
                {error || `${t.partialResult} · ${stats?.errorCount}`}
              </summary>
              {stats?.errors.map((message, index) => (
                <p key={index}>{message}</p>
              ))}
            </details>
          )}
          <footer className="search-result-actions">
            <button
              disabled={!current || opening}
              data-shortcut="Enter / Ctrl+Enter"
              onClick={() => void open("go")}
            >
              <ArrowRight size={14} />
              {t.goToFile}
              <kbd>Enter</kbd>
            </button>
            <button
              disabled={!current || current.entry.isDir || opening}
              data-shortcut="F3"
              onClick={() => void open("view")}
            >
              <Eye size={14} />
              {t.view}
              <kbd>F3</kbd>
            </button>
            <button
              disabled={
                !current ||
                current.entry.isDir ||
                location.source.startsWith("zip:") ||
                opening
              }
              data-shortcut="F4"
              onClick={() => void open("edit")}
            >
              <FilePenLine size={14} />
              {t.edit}
              <kbd>F4</kbd>
            </button>
          </footer>
        </div>
      </Modal>
      {document?.mode === "view" && (
        <PreviewDialog
          location={{ ...location, path: document.hit.entry.path }}
          initialLine={document.line}
          initialColumn={document.column}
          connection={document.connection}
          t={t}
          onClose={() => setDocument(undefined)}
          onEdit={
            location.source.startsWith("zip:")
              ? undefined
              : (line, column) =>
                  setDocument({
                    ...document,
                    mode: "edit",
                    line: line || document.line,
                    column: column || document.column,
                  })
          }
        />
      )}
      {document?.mode === "edit" && (
        <TextWorkbench
          location={{ ...location, path: document.hit.entry.path }}
          initialLine={document.line}
          initialColumn={document.column}
          connection={document.connection}
          t={t}
          editable
          destinations={destinations}
          onSaved={onSaved}
          onClose={() => setDocument(undefined)}
        />
      )}
      {help && <ShortcutsDialog t={t} onClose={() => setHelp(false)} />}
    </>
  );
}
