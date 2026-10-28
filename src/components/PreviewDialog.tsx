import { useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  FileQuestion,
  LoaderCircle,
  ExternalLink,
} from "lucide-react";
import * as api from "../api";
import { basename, size, uid } from "../utils";
import { IconButton, Modal } from "./Primitives";
import type { Location, Preview, TextHit, TextPosition } from "../types";
import type { Text } from "../i18n";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { TextWorkbench } from "./TextWorkbench";
export function PreviewDialog({
  location,
  t,
  onClose,
  onEdit,
  initialLine = 1,
  initialColumn = 1,
  connection,
}: {
  location: Location;
  t: Text;
  onClose: () => void;
  onEdit?: (line?: number, column?: number, connection?: string | null) => void;
  initialLine?: number;
  initialColumn?: number;
  connection?: string | null;
}) {
  const [target, setTarget] = useState({
    line: initialLine,
    column: initialColumn,
    length: 0,
    version: 0,
  });
  const [data, setData] = useState<Preview>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [findStatus, setFindStatus] = useState("");
  const request = useRef<{ id: string; kind: "page" | "find" } | undefined>(
    undefined,
  );
  const boundConnection = useRef(connection);
  function cancelRequest() {
    const active = request.current;
    request.current = undefined;
    if (active && api.desktop)
      void api.command("cancel_search", { id: active.id }).catch(() => {});
  }
  function begin(kind: "page" | "find") {
    cancelRequest();
    const id = uid();
    request.current = { id, kind };
    setLoading(true);
    setError("");
    return id;
  }
  function accept(preview: Preview, position: TextPosition, length = 0) {
    boundConnection.current = preview.connection;
    setData(preview);
    setTarget((target) => ({
      ...position,
      length,
      version: target.version + 1,
    }));
  }
  function loadPage(line: number, column = 1) {
    const id = begin("page");
    setFindStatus("");
    api
      .command<Preview>("get_preview", {
        location,
        line,
        connection: boundConnection.current,
        id,
      })
      .then((d) => {
        if (request.current?.id === id) accept(d, { line, column });
      })
      .catch((e) => {
        if (request.current?.id === id) setError(String(e));
      })
      .finally(() => {
        if (request.current?.id === id) {
          request.current = undefined;
          setLoading(false);
        }
      });
  }
  function find(query: string, from: TextPosition, previous: boolean) {
    const id = begin("find");
    setFindStatus("");
    api
      .command<{ hit: TextHit | null; preview: Preview | null }>("find_text", {
        id,
        location,
        query,
        from,
        previous,
        connection: boundConnection.current,
      })
      .then(({ hit, preview }) => {
        if (request.current?.id !== id) return;
        if (hit && preview) {
          accept(preview, hit, hit.length);
          setFindStatus(hit.wrapped ? t.searchWrapped : "");
        } else setFindStatus(t.noTextMatch);
      })
      .catch((e) => {
        if (request.current?.id === id) setError(String(e));
      })
      .finally(() => {
        if (request.current?.id === id) {
          request.current = undefined;
          setLoading(false);
        }
      });
  }
  function cancelFind() {
    if (request.current?.kind === "find") {
      cancelRequest();
      setLoading(false);
    }
    setFindStatus("");
  }
  useEffect(() => {
    boundConnection.current = connection;
    setData(undefined);
    loadPage(initialLine, initialColumn);
    return cancelRequest;
  }, [location.source, location.path, connection]);
  useEffect(() => {
    if (data?.kind === "text") return;
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "F10" || e.key === "F3") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose, data?.kind]);
  if (data?.kind === "text")
    return (
      <TextWorkbench
        location={location}
        t={t}
        initial={data.data}
        truncated={data.truncated}
        lineOffset={(data.startLine || 1) - 1}
        initialEncoding={data.encoding}
        initialLineEnding={data.lineEnding}
        initialLine={target.line}
        initialColumn={target.column}
        initialSelectionLength={target.length}
        initialVersion={target.version}
        viewLoading={loading}
        viewError={error}
        findStatus={findStatus}
        findLoading={loading && request.current?.kind === "find"}
        onFind={find}
        onCancelFind={cancelFind}
        onGotoLine={loadPage}
        onPage={(delta) =>
          loadPage(
            delta > 0
              ? (data.endLine || 1) + 1
              : Math.max(1, (data.startLine || 1) - 2000),
          )
        }
        hasPrevious={(data.startLine || 1) > 1}
        hasNext={!!data.hasMore}
        onClose={onClose}
        onEdit={
          onEdit
            ? (line, column) => onEdit(line, column, boundConnection.current)
            : undefined
        }
      />
    );
  return (
    <Modal
      closeLabel={t.close}
      title={basename(location.path)}
      subtitle={data ? `${size(data.size)} · ${data.mime}` : location.path}
      onClose={onClose}
      wide
      full
    >
      <div className="preview-body">
        {error ? (
          <p className="inline-error">{error}</p>
        ) : !data ? (
          <div className="empty-state">
            <LoaderCircle className="spin" />
          </div>
        ) : data.kind === "image" ? (
          <img
            alt={basename(location.path)}
            src={`data:${data.mime};base64,${data.data}`}
          />
        ) : data.kind === "pdf" ? (
          <PdfPreview data={data.data} t={t} />
        ) : (
          <div className="empty-state">
            <FileQuestion size={36} />
            <h3>{t.noPreview}</h3>
            <p>{t.previewHint}</p>
            {location.source === "local" && (
              <button
                className="primary"
                onClick={() =>
                  api
                    .command("open_file", { path: location.path, edit: false })
                    .catch((e) => setError(String(e)))
                }
              >
                <ExternalLink size={14} />
                {t.open}
              </button>
            )}
          </div>
        )}
      </div>
      <footer className="workbench-keys">
        <button onClick={onClose}>
          <kbd>F10</kbd>
          {t.close}
          <small>Esc / F3</small>
        </button>
      </footer>
    </Modal>
  );
}
function PdfPreview({ data, t }: { data: string; t: Text }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(0);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    import("pdfjs-dist")
      .then(async (pdf) => {
        pdf.GlobalWorkerOptions.workerSrc = pdfWorker;
        const task = pdf.getDocument({
          data: Uint8Array.from(atob(data), (c) => c.charCodeAt(0)),
          enableXfa: false,
        });
        cleanup = () => {
          void task.destroy();
        };
        const doc = await task.promise;
        if (cancelled) {
          void task.destroy();
          return;
        }
        setPages(doc.numPages);
        const item = await doc.getPage(page);
        if (cancelled || !canvas.current) return;
        const viewport = item.getViewport({ scale: 1.4 });
        const el = canvas.current;
        el.width = viewport.width;
        el.height = viewport.height;
        const render = item.render({
          canvas: el,
          canvasContext: el.getContext("2d")!,
          viewport,
        });
        await render.promise;
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [data, page]);
  return (
    <div className="pdf-preview">
      <div className="pdf-controls">
        <IconButton
          title={t.back}
          disabled={page <= 1}
          onClick={() => setPage((p) => p - 1)}
        >
          <ChevronLeft size={16} />
        </IconButton>
        <span>
          {t.page} {page} / {pages || "…"}
        </span>
        <IconButton
          title={t.forward}
          disabled={page >= pages}
          onClick={() => setPage((p) => p + 1)}
        >
          <ChevronRight size={16} />
        </IconButton>
      </div>
      {error ? (
        <p className="inline-error">{error}</p>
      ) : (
        <canvas ref={canvas} />
      )}
    </div>
  );
}
