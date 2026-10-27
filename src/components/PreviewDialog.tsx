import { useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  FileQuestion,
  LoaderCircle,
  ExternalLink,
} from "lucide-react";
import * as api from "../api";
import { basename, size } from "../utils";
import { IconButton, Modal } from "./Primitives";
import type { Location, Preview } from "../types";
import type { Text } from "../i18n";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
export function PreviewDialog({
  location,
  t,
  onClose,
}: {
  location: Location;
  t: Text;
  onClose: () => void;
}) {
  const [data, setData] = useState<Preview>();
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    setData(undefined);
    setError("");
    api
      .command<Preview>("get_preview", { location })
      .then((d) => {
        if (alive) setData(d);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [location.source, location.path]);
  return (
    <Modal
      title={basename(location.path)}
      subtitle={data ? `${size(data.size)} · ${data.mime}` : location.path}
      onClose={onClose}
      wide
    >
      <div className="preview-body">
        {error ? (
          <p className="inline-error">{error}</p>
        ) : !data ? (
          <div className="empty-state">
            <LoaderCircle className="spin" />
          </div>
        ) : data.kind === "text" ? (
          <>
            <pre>{data.data}</pre>
            {data.truncated && <p className="preview-note">{t.truncated}</p>}
          </>
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
