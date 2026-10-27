import { useEffect, useMemo, useRef, useState } from "react";
import { Folder, Info, LoaderCircle, RefreshCw } from "lucide-react";
import * as api from "../api";
import { size, uid } from "../utils";
import { Modal } from "./Primitives";
import type {
  AttributeChanges,
  Entry,
  FileProperties,
  Location,
  SizeSummary,
} from "../types";
import type { Text } from "../i18n";

function Flag({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: boolean | null;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (input.current) input.current.indeterminate = value === null;
  }, [value]);
  return (
    <label className="property-flag">
      <input
        ref={input}
        type="checkbox"
        checked={value === true}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}
const common = (values: (boolean | null)[]) =>
  values.length && values.every((value) => value === values[0])
    ? values[0]
    : null;
const date = (value: number | null | undefined) =>
  value
    ? new Date(value * 1000).toLocaleString(document.documentElement.lang)
    : "—";

export function PropertiesDialog({
  location,
  entries,
  t,
  onClose,
  onChanged,
}: {
  location: Location;
  entries: Entry[];
  t: Text;
  onClose: () => void;
  onChanged: () => void;
}) {
  const details = useRef<(FileProperties | undefined)[]>([]);
  const [version, setVersion] = useState(0),
    [generation, setGeneration] = useState(0);
  const [loadDetails, setLoadDetails] = useState(entries.length <= 256);
  const [loaded, setLoaded] = useState(0),
    [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [readonly, setReadonly] = useState<boolean>(),
    [hidden, setHidden] = useState<boolean>();
  const [modeInput, setModeInput] = useState<string>(),
    [modeSet, setModeSet] = useState(0),
    [modeClear, setModeClear] = useState(0);
  const [progress, setProgress] = useState<{ done: number; total: number }>();
  const [summary, setSummary] = useState<SizeSummary>();
  const sizeTask = useRef<string | undefined>(undefined);
  const applying = useRef(false),
    abort = useRef(false),
    closeAfter = useRef(false),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      abort.current = true;
      if (sizeTask.current)
        void api
          .command("cancel_search", { id: sizeTask.current })
          .catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (!loadDetails) return;
    let active = true,
      next = 0,
      done = 0;
    const failures: string[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    details.current = Array(entries.length);
    setLoading(true);
    setLoaded(0);
    setErrors([]);
    const flush = () => {
      timer = undefined;
      if (active) {
        setLoaded(done);
        setVersion((v) => v + 1);
      }
    };
    const worker = async () => {
      while (active && next < entries.length) {
        const index = next++;
        try {
          const value = await api.properties(
            { ...location, path: entries[index].path },
            entries[index],
          );
          if (active) details.current[index] = value;
        } catch (error) {
          if (active && failures.length < 10)
            failures.push(`${entries[index].name}: ${error}`);
        }
        if (!active) return;
        done++;
        if (!timer) timer = setTimeout(flush, 60);
      }
    };
    void Promise.all(
      Array.from({ length: Math.min(4, entries.length) }, worker),
    ).then(() => {
      if (active) {
        clearTimeout(timer);
        flush();
        setLoading(false);
        setErrors([...failures]);
      }
    });
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [location.source, entries, generation, loadDetails]);
  const infos = useMemo(
    () =>
      !loading
        ? details.current.filter((value): value is FileProperties => !!value)
        : [],
    [version, loading],
  );
  const indices = useMemo(
    () => new Map(entries.map((entry, index) => [entry.path, index])),
    [entries],
  );
  const single = entries.length === 1 ? infos[0] : undefined;
  const totals = useMemo(
    () =>
      entries.reduce(
        (total, selected, index) => {
          const entry = details.current[index]?.file || selected;
          if (entry.isSymlink) total.links++;
          else if (entry.isDir) total.folders++;
          else {
            total.files++;
            total.bytes += entry.size;
          }
          return total;
        },
        { files: 0, folders: 0, links: 0, bytes: 0 },
      ),
    [entries, version, loading],
  );
  const canReadonly = infos.some((info) => info.editable.readonly),
    canHidden = infos.some((info) => info.editable.hidden),
    canMode = infos.some((info) => info.editable.mode);
  const invalidMode =
    modeInput !== undefined && !/^[0-7]{3,4}$/.test(modeInput);
  const mode =
    modeInput !== undefined && !invalidMode
      ? Number.parseInt(modeInput, 8)
      : undefined;
  const effectiveMode = (info: FileProperties) =>
    ((mode ?? info.mode ?? 0) | modeSet) & ~modeClear;
  const modes = infos.filter((info) => info.editable.mode);
  const commonMode =
    modes.length &&
    modes.every((info) => effectiveMode(info) === effectiveMode(modes[0]))
      ? effectiveMode(modes[0])
      : undefined;
  function changes(info: FileProperties): AttributeChanges {
    const value: AttributeChanges = {};
    if (
      info.editable.readonly &&
      readonly !== undefined &&
      readonly !== info.readonly
    )
      value.readonly = readonly;
    if (info.editable.hidden && hidden !== undefined && hidden !== info.hidden)
      value.hidden = hidden;
    if (
      info.editable.mode &&
      !invalidMode &&
      (mode !== undefined || modeSet || modeClear) &&
      effectiveMode(info) !== info.mode
    ) {
      if (mode !== undefined) value.mode = mode;
      value.modeSet = modeSet;
      value.modeClear = modeClear;
    }
    return value;
  }
  const candidates = infos
    .map((info) => ({ info, changes: changes(info) }))
    .filter((value) => Object.keys(value.changes).length);
  function close() {
    if (applying.current) {
      abort.current = true;
      closeAfter.current = true;
      return;
    }
    onClose();
  }
  async function apply() {
    if (invalidMode) {
      setErrors([t.invalidMode]);
      return;
    }
    if (applying.current || !candidates.length) return;
    applying.current = true;
    abort.current = false;
    setBusy(true);
    setErrors([]);
    const failures: string[] = [];
    let done = 0,
      last = Date.now();
    setProgress({ done: 0, total: candidates.length });
    for (const candidate of candidates) {
      if (abort.current) break;
      try {
        const value = await api.command<FileProperties>("apply_properties", {
          location: { ...location, path: candidate.info.file.path },
          revision: candidate.info.revision,
          changes: candidate.changes,
        });
        const index = indices.get(candidate.info.file.path);
        if (index !== undefined) details.current[index] = value;
      } catch (error) {
        if (failures.length < 10)
          failures.push(`${candidate.info.file.name}: ${error}`);
      }
      done++;
      if (Date.now() - last > 100) {
        setProgress({ done, total: candidates.length });
        last = Date.now();
      }
    }
    applying.current = false;
    if (alive.current) {
      setBusy(false);
      setProgress({ done, total: candidates.length });
      setErrors(failures);
      setVersion((v) => v + 1);
      onChanged();
      if (closeAfter.current) onClose();
    }
  }
  async function calculate() {
    const id = `properties-${uid()}`;
    sizeTask.current = id;
    setSummary({
      files: 0,
      folders: 0,
      links: 0,
      bytes: 0,
      errors: [],
      errorCount: 0,
      done: false,
      cancelled: false,
    });
    try {
      await api.calculateSize(
        location.source,
        entries.map((entry) => entry.path),
        id,
        (value) => {
          if (alive.current && sizeTask.current === id) setSummary(value);
        },
      );
    } catch (error) {
      if (alive.current && sizeTask.current === id) {
        setErrors([String(error)]);
        setSummary(undefined);
      }
    } finally {
      if (sizeTask.current === id) sizeTask.current = undefined;
    }
  }
  function refresh() {
    if (sizeTask.current)
      void api
        .command("cancel_search", { id: sizeTask.current })
        .catch(() => {});
    sizeTask.current = undefined;
    setSummary(undefined);
    setReadonly(undefined);
    setHidden(undefined);
    setModeInput(undefined);
    setModeSet(0);
    setModeClear(0);
    setProgress(undefined);
    setErrors([]);
    setLoadDetails(true);
    setGeneration((v) => v + 1);
  }
  const counts = summary || totals;
  return (
    <Modal
      closeLabel={t.close}
      title={t.properties}
      subtitle={
        entries.length === 1
          ? entries[0].path
          : `${entries.length.toLocaleString()} ${t.items}`
      }
      onClose={close}
      wide
    >
      <section className="properties-overview">
        <div className="property-kind">
          <Info size={23} />
          <div>
            <strong>
              {entries.length === 1 ? entries[0].name : t.selection}
            </strong>
            <small>
              {entries.length === 1
                ? entries[0].isSymlink
                  ? t.symbolicLink
                  : entries[0].isDir
                    ? t.folder
                    : t.file
                : `${entries.length.toLocaleString()} ${t.items}`}
            </small>
          </div>
        </div>
        <dl className="property-facts">
          <div>
            <dt>{t.totalSize}</dt>
            <dd>
              {totals.folders && !summary ? "—" : size(counts.bytes)}
              {(!totals.folders || summary) && counts.bytes >= 1024 && (
                <small>{counts.bytes.toLocaleString()} B</small>
              )}
            </dd>
          </div>
          <div>
            <dt>{t.contains}</dt>
            <dd>
              {counts.files.toLocaleString()}{" "}
              {counts.files === 1 ? t.oneFile : t.files} ·{" "}
              {counts.folders.toLocaleString()}{" "}
              {counts.folders === 1 ? t.oneFolder : t.folders}
              {counts.links
                ? ` · ${counts.links.toLocaleString()} ${counts.links === 1 ? t.oneLink : t.links}`
                : ""}
            </dd>
          </div>
          {single && (
            <>
              <div>
                <dt>{t.modified}</dt>
                <dd>{date(single.file.modified)}</dd>
              </div>
              <div>
                <dt>{t.created}</dt>
                <dd>{date(single.created)}</dd>
              </div>
              <div>
                <dt>{t.accessed}</dt>
                <dd>{date(single.accessed)}</dd>
              </div>
              {single.uid !== null && (
                <div>
                  <dt>{t.ownerGroup}</dt>
                  <dd>
                    {single.uid} / {single.gid ?? "—"}
                  </dd>
                </div>
              )}
              {single.linkTarget && (
                <div className="property-wide">
                  <dt>{t.linkTarget}</dt>
                  <dd>
                    <code>{single.linkTarget}</code>
                  </dd>
                </div>
              )}
              {(single.system || single.compressed || single.encrypted) && (
                <div className="property-wide">
                  <dt>{t.attributes}</dt>
                  <dd>
                    {[
                      single.system && t.systemAttribute,
                      single.compressed && t.compressed,
                      single.encrypted && t.encrypted,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </dd>
                </div>
              )}
            </>
          )}
        </dl>
        {!!totals.folders && (
          <div className="property-scan">
            <button
              disabled={busy || (!!summary && !summary.done)}
              onClick={() => void calculate()}
            >
              <Folder size={14} />
              {t.calculateSize}
            </button>
            {summary && !summary.done && (
              <>
                <LoaderCircle size={13} className="spin" />
                <button
                  onClick={() =>
                    sizeTask.current &&
                    void api
                      .command("cancel_search", { id: sizeTask.current })
                      .catch((error) => setErrors([String(error)]))
                  }
                >
                  {t.cancel}
                </button>
              </>
            )}
            {summary?.cancelled && <span>{t.cancelled}</span>}
            {!!summary?.errorCount && (
              <span className="inline-error">
                {t.partialResult} · {summary.errorCount}
              </span>
            )}
          </div>
        )}
      </section>
      {entries.length > 1 && (
        <details className="property-selection">
          <summary>
            {t.selectedItems} ({entries.length.toLocaleString()})
          </summary>
          {entries.slice(0, 50).map((entry) => (
            <code key={entry.path}>{entry.path}</code>
          ))}
          {entries.length > 50 && (
            <small>
              +{entries.length - 50} {t.items}
            </small>
          )}
        </details>
      )}
      {!loadDetails ? (
        <button className="property-load" onClick={() => setLoadDetails(true)}>
          {t.loadAttributes}
        </button>
      ) : loading ? (
        <p className="helper">
          <LoaderCircle size={13} className="spin" /> {t.loadingAttributes} ·{" "}
          {loaded}/{entries.length}
        </p>
      ) : (
        <fieldset className="property-attributes" disabled={busy}>
          <legend>{t.attributes}</legend>
          {(canReadonly || canHidden) && (
            <div className="property-flags">
              {canReadonly && (
                <Flag
                  label={t.readonlyAttribute}
                  value={
                    readonly ??
                    common(
                      infos
                        .filter((info) => info.editable.readonly)
                        .map((info) => info.readonly),
                    )
                  }
                  disabled={!canReadonly}
                  onChange={setReadonly}
                />
              )}
              {canHidden && (
                <Flag
                  label={t.hiddenAttribute}
                  value={
                    hidden ??
                    common(
                      infos
                        .filter((info) => info.editable.hidden)
                        .map((info) => info.hidden),
                    )
                  }
                  disabled={!canHidden}
                  onChange={setHidden}
                />
              )}
            </div>
          )}
          {canMode && (
            <>
              <label className="property-mode">
                {t.permissions}
                <input
                  aria-label={t.octalPermissions}
                  spellCheck={false}
                  maxLength={4}
                  value={
                    modeInput ??
                    (commonMode === undefined
                      ? ""
                      : commonMode.toString(8).padStart(4, "0"))
                  }
                  placeholder={t.mixed}
                  onChange={(event) => {
                    setModeInput(event.target.value);
                    setModeSet(0);
                    setModeClear(0);
                  }}
                />
                <small>0000–7777</small>
              </label>
              <table className="permissions-table">
                <thead>
                  <tr>
                    <th></th>
                    {[
                      t.readPermission,
                      t.writePermission,
                      t.executePermission,
                    ].map((label) => (
                      <th key={label}>{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[t.owner, t.group, t.others].map((label, row) => (
                    <tr key={label}>
                      <th>{label}</th>
                      {[4, 2, 1].map((bit) => {
                        const mask = bit << (6 - row * 3),
                          value = common(
                            modes.map(
                              (info) => (effectiveMode(info) & mask) !== 0,
                            ),
                          );
                        return (
                          <td key={bit}>
                            <Flag
                              label={`${label} · ${[t.readPermission, t.writePermission, t.executePermission][[4, 2, 1].indexOf(bit)]}`}
                              value={value}
                              disabled={invalidMode}
                              onChange={(checked) => {
                                if (
                                  modeInput !== undefined &&
                                  mode !== undefined
                                )
                                  setModeInput(
                                    (checked ? mode | mask : mode & ~mask)
                                      .toString(8)
                                      .padStart(4, "0"),
                                  );
                                else {
                                  setModeSet((old) =>
                                    checked ? old | mask : old & ~mask,
                                  );
                                  setModeClear((old) =>
                                    checked ? old & ~mask : old | mask,
                                  );
                                }
                              }}
                            />
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {!canReadonly && !canHidden && !canMode && (
            <p className="helper">{t.attributesUnavailable}</p>
          )}
          {(canReadonly || canHidden || canMode) && (
            <p className="helper">{t.attributesHint}</p>
          )}
        </fieldset>
      )}
      {!!errors.length && (
        <div className="inline-error property-errors" role="alert">
          {errors.map((error, index) => (
            <p key={index}>{error}</p>
          ))}
        </div>
      )}
      {!!summary?.errors.length && (
        <details className="property-errors">
          <summary>{t.partialResult}</summary>
          {summary.errors.map((error, index) => (
            <p key={index}>{error}</p>
          ))}
        </details>
      )}
      <footer className="modal-actions property-actions">
        {progress && (
          <small>
            {progress.done}/{progress.total} {t.processed}
          </small>
        )}
        <button disabled={busy || loading} onClick={refresh}>
          <RefreshCw size={13} />
          {t.refresh}
        </button>
        <button onClick={close}>{t.close}</button>
        {busy ? (
          <button
            onClick={() => {
              abort.current = true;
            }}
          >
            {t.cancel}
          </button>
        ) : (
          <button
            className="primary"
            disabled={
              loading || !loadDetails || (!candidates.length && !invalidMode)
            }
            onClick={() => void apply()}
          >
            {t.applyChanges}
          </button>
        )}
      </footer>
    </Modal>
  );
}
