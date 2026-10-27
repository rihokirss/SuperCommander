import { useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Pencil,
  Plus,
  Search,
  Star,
  Trash2,
} from "lucide-react";
import { IconButton, Modal } from "./Primitives";
import { bookmarkKey, bookmarkPath } from "../bookmarks";
import { basename } from "../utils";
import type { Bookmark, Settings } from "../types";
import type { Text } from "../i18n";

export function BookmarksDialog({
  settings,
  seed,
  t,
  update,
  onOpen,
  onClose,
}: {
  settings: Settings;
  seed?: Bookmark | null;
  t: Text;
  update: (patch: Partial<Settings>) => void;
  onOpen: (bookmark: Bookmark) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(seed?.name || "");
  const [path, setPath] = useState(seed?.path || "");
  const [source, setSource] = useState(seed?.source);
  const [editing, setEditing] = useState<string | undefined>(
    seed && settings.bookmarks.some((b) => bookmarkKey(b) === bookmarkKey(seed))
      ? bookmarkKey(seed)
      : undefined,
  );
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  function reset() {
    setName("");
    setPath("");
    setSource(undefined);
    setEditing(undefined);
    setError("");
  }
  function move(bookmark: Bookmark, delta: number) {
    const entries = [...settings.bookmarks],
      index = entries.findIndex(
        (b) => bookmarkKey(b) === bookmarkKey(bookmark),
      );
    if (index < 0 || index + delta < 0 || index + delta >= entries.length)
      return;
    [entries[index], entries[index + delta]] = [
      entries[index + delta],
      entries[index],
    ];
    update({ bookmarks: entries });
  }
  return (
    <Modal
      closeLabel={t.close}
      title={t.manageBookmarks}
      subtitle={t.bookmarksHint}
      onClose={onClose}
      wide
    >
      <form
        className="bookmark-form"
        onSubmit={(event) => {
          event.preventDefault();
          const target = bookmarkPath(path.trim(), source);
          if (!target) {
            setError(t.bookmarkInvalid);
            return;
          }
          const value = {
            ...target,
            name: name.trim() || basename(path),
            kind: "bookmark",
          };
          if (
            settings.bookmarks.some(
              (b) =>
                bookmarkKey(b) === bookmarkKey(value) &&
                bookmarkKey(b) !== editing,
            )
          ) {
            setError(t.bookmarkDuplicate);
            return;
          }
          const entries = [...settings.bookmarks];
          const index = entries.findIndex((b) => bookmarkKey(b) === editing);
          if (index >= 0) entries[index] = value;
          else entries.push(value);
          update({ bookmarks: entries });
          reset();
          input.current?.focus();
        }}
      >
        <label className="field">
          {t.bookmarkName}
          <input
            ref={input}
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="field">
          {t.bookmarkPath}
          <input
            spellCheck={false}
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder={
              source?.startsWith("zip:")
                ? "/folder"
                : "C:\\folder · ssh://alias/path"
            }
          />
          {source?.startsWith("zip:") && (
            <small>{basename(source.slice(4))}</small>
          )}
        </label>
        <div className="bookmark-form-actions">
          <button className="primary">
            {editing ? <Check size={13} /> : <Plus size={13} />}
            {editing ? t.saveChanges : t.addBookmark}
          </button>
          {editing && (
            <button type="button" onClick={reset}>
              {t.cancel}
            </button>
          )}
        </div>
      </form>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <label className="bookmark-filter">
        <Search size={14} />
        <input
          aria-label={t.filterBookmarks}
          placeholder={t.filterBookmarks}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div className="bookmark-list">
        {!settings.bookmarks.length && (
          <p className="helper">{t.noBookmarks}</p>
        )}
        {settings.bookmarks
          .filter((b) =>
            `${b.name} ${b.path}`.toLowerCase().includes(query.toLowerCase()),
          )
          .map((bookmark) => {
            const index = settings.bookmarks.indexOf(bookmark);
            return (
              <div className="bookmark-row" key={bookmarkKey(bookmark)}>
                <Star size={14} />
                <button
                  className="bookmark-open"
                  data-tooltip={bookmark.path}
                  onClick={() => onOpen(bookmark)}
                >
                  <strong>{bookmark.name}</strong>
                  <code>
                    {bookmark.source?.startsWith("zip:")
                      ? `${basename(bookmark.source.slice(4))} · `
                      : ""}
                    {bookmark.path}
                  </code>
                </button>
                <IconButton
                  title={`${t.moveBookmarkUp} ${bookmark.name}`}
                  disabled={index === 0}
                  onClick={() => move(bookmark, -1)}
                >
                  <ArrowUp size={13} />
                </IconButton>
                <IconButton
                  title={`${t.moveBookmarkDown} ${bookmark.name}`}
                  disabled={index === settings.bookmarks.length - 1}
                  onClick={() => move(bookmark, 1)}
                >
                  <ArrowDown size={13} />
                </IconButton>
                <IconButton
                  title={`${t.edit} ${bookmark.name}`}
                  onClick={() => {
                    setName(bookmark.name);
                    setPath(bookmark.path);
                    setSource(bookmark.source);
                    setEditing(bookmarkKey(bookmark));
                    setError("");
                    input.current?.focus();
                  }}
                >
                  <Pencil size={13} />
                </IconButton>
                <IconButton
                  title={`${t.removeFavorite} ${bookmark.name}`}
                  onClick={() => {
                    update({
                      bookmarks: settings.bookmarks.filter(
                        (b) => bookmarkKey(b) !== bookmarkKey(bookmark),
                      ),
                    });
                    if (editing === bookmarkKey(bookmark)) reset();
                  }}
                >
                  <Trash2 size={13} />
                </IconButton>
              </div>
            );
          })}
      </div>
      <footer className="modal-actions">
        <button onClick={onClose}>{t.close}</button>
      </footer>
    </Modal>
  );
}
