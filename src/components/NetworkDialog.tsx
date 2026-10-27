import { useState } from "react";
import {
  Check,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Undo2,
  Wifi,
} from "lucide-react";
import { IconButton, Modal } from "./Primitives";
import { networkKey, networkLocations, networkPath } from "../network";
import { basename } from "../utils";
import type { Place, Settings } from "../types";
import type { Text } from "../i18n";
export function NetworkDialog({
  settings,
  detected,
  t,
  onClose,
  update,
  onRefresh,
  onOpen,
}: {
  settings: Settings;
  detected: Place[];
  t: Text;
  onClose: () => void;
  update: (patch: Partial<Settings>) => void;
  onRefresh: () => Promise<void>;
  onOpen: (path: string) => void;
}) {
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [editing, setEditing] = useState<string>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const locations = networkLocations(settings, detected);
  const saved = settings.networkLocations || [];
  const hidden = settings.hiddenNetworkPaths || [];
  const removed = detected.filter(
    (p) => !locations.some((l) => networkKey(p.path) === networkKey(l.path)),
  );
  function remove(place: Place) {
    update({
      networkLocations: saved.filter(
        (p) => networkKey(p.path) !== networkKey(place.path),
      ),
      hiddenNetworkPaths: [...new Set([...hidden, networkKey(place.path)])],
    });
    if (editing === networkKey(place.path)) {
      setEditing(undefined);
      setName("");
      setPath("");
    }
  }
  return (
    <Modal
      title={t.networkLocations}
      subtitle={t.networkHint}
      onClose={onClose}
      wide
    >
      <form
        className="network-form"
        onSubmit={(e) => {
          e.preventDefault();
          const target = networkPath(path);
          if (!target) {
            setError(t.networkInvalid);
            return;
          }
          if (
            locations.some(
              (p) =>
                networkKey(p.path) === networkKey(target) &&
                networkKey(p.path) !== editing,
            )
          ) {
            setError(t.networkDuplicate);
            return;
          }
          update({
            networkLocations: [
              ...saved.filter(
                (p) =>
                  networkKey(p.path) !== editing &&
                  networkKey(p.path) !== networkKey(target),
              ),
              {
                name: name.trim() || basename(target),
                path: target,
                kind: "network",
              },
            ],
            hiddenNetworkPaths: [
              ...hidden.filter((p) => networkKey(p) !== networkKey(target)),
              ...(editing && editing !== networkKey(target) ? [editing] : []),
            ],
          });
          setName("");
          setPath("");
          setEditing(undefined);
          setError("");
        }}
      >
        <label className="field">
          {t.name}
          <input
            aria-label={t.networkName}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t.networkName}
          />
        </label>
        <label className="field">
          {t.networkPath}
          <input
            aria-label={t.networkPath}
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="\\server\share"
            required
            spellCheck={false}
          />
        </label>
        <button type="submit" className="primary">
          {editing ? <Check size={13} /> : <Plus size={13} />}{" "}
          {editing ? t.saveChanges : t.addLocation}
        </button>
        {editing && (
          <button
            type="button"
            onClick={() => {
              setEditing(undefined);
              setName("");
              setPath("");
            }}
          >
            {t.cancel}
          </button>
        )}
      </form>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <div className="network-list">
        {!locations.length && <p className="helper">{t.networkEmpty}</p>}
        {locations.map((place) => (
          <div className="network-location" key={networkKey(place.path)}>
            <Wifi size={14} />
            <button
              className="network-open"
              data-tooltip={place.path}
              onClick={() => onOpen(place.path)}
            >
              <strong>{place.name}</strong>
              <code>{place.path}</code>
            </button>
            <small>
              {saved.some((p) => networkKey(p.path) === networkKey(place.path))
                ? t.savedLocation
                : t.fromExplorer}
            </small>
            <IconButton
              title={`${t.edit} ${place.name}`}
              onClick={() => {
                setEditing(networkKey(place.path));
                setName(place.name);
                setPath(place.path);
                setError("");
              }}
            >
              <Pencil size={13} />
            </IconButton>
            <IconButton
              title={`${t.removeLocation} ${place.name}`}
              onClick={() => remove(place)}
            >
              <Trash2 size={13} />
            </IconButton>
          </div>
        ))}
      </div>
      {!!removed.length && (
        <details className="network-available">
          <summary>
            {t.fromExplorer} ({removed.length})
          </summary>
          {removed.map((place) => (
            <div className="network-location" key={networkKey(place.path)}>
              <span>{place.name}</span>
              <code>{place.path}</code>
              <IconButton
                title={`${t.restoreLocation} ${place.name}`}
                onClick={() =>
                  update({
                    hiddenNetworkPaths: hidden.filter(
                      (p) => networkKey(p) !== networkKey(place.path),
                    ),
                  })
                }
              >
                <Undo2 size={13} />
              </IconButton>
            </div>
          ))}
        </details>
      )}
      <footer className="modal-actions">
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await onRefresh();
            } catch (e) {
              setError(String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          <RefreshCw size={13} className={busy ? "spin" : ""} />
          {t.refreshExplorer}
        </button>
        <button onClick={onClose}>{t.close}</button>
      </footer>
    </Modal>
  );
}
