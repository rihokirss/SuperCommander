import { useState } from "react";
import {
  ArrowDownUp,
  CheckCircle2,
  CircleAlert,
  Clock3,
  LoaderCircle,
  X,
} from "lucide-react";
import { command } from "../api";
import { basename, size } from "../utils";
import { IconButton } from "./Primitives";
import type { Job } from "../types";
import type { Text } from "../i18n";
export function QueuePanel({
  jobs,
  t,
  onClose,
  onClear,
  onError,
}: {
  jobs: Job[];
  t: Text;
  onClose: () => void;
  onClear: () => void;
  onError: (error: string) => void;
}) {
  return (
    <section className="queue-panel glass">
      <header>
        <span>
          <ArrowDownUp size={14} />
          {t.queue}
          <small>{jobs.length}</small>
        </span>
        <div>
          <button className="text-button" onClick={onClear}>
            {t.clearJobs}
          </button>
          <IconButton title={t.close} onClick={onClose}>
            <X size={14} />
          </IconButton>
        </div>
      </header>
      <div className="queue-scroll">
        {!jobs.length ? (
          <div className="queue-empty">
            <CheckCircle2 size={24} />
            <div>
              <strong>{t.noJobs}</strong>
              <p>{t.noJobsHint}</p>
            </div>
          </div>
        ) : (
          [...jobs]
            .reverse()
            .map((job) => (
              <JobRow key={job.id} job={job} t={t} onError={onError} />
            ))
        )}
      </div>
    </section>
  );
}
function JobRow({
  job,
  t,
  onError,
}: {
  job: Job;
  t: Text;
  onError: (error: string) => void;
}) {
  const [all, setAll] = useState(false);
  const pending = ["running", "queued", "conflict"].includes(job.state);
  const Icon =
    job.state === "completed"
      ? CheckCircle2
      : job.state === "failed" || job.state === "conflict"
        ? CircleAlert
        : job.state === "queued"
          ? Clock3
          : LoaderCircle;
  return (
    <div className={`job-row ${job.state}`}>
      <Icon size={14} className={job.state === "running" ? "spin" : ""} />
      <div className="job-main">
        <div>
          <strong title={job.current}>
            {t[job.operation]}{" "}
            <span>· {basename(job.current) || `${job.count} ${t.items}`}</span>
          </strong>
          <small>
            {job.state === "conflict" ? t.conflict : t[job.state]}{" "}
            {job.total > 0 && `· ${size(job.bytes)} / ${size(job.total)}`}
          </small>
        </div>
        {pending && (
          <div className={`progress-track ${job.total ? "" : "indeterminate"}`}>
            <span
              style={{
                width: job.total
                  ? `${Math.min(100, (job.bytes / job.total) * 100)}%`
                  : "30%",
              }}
            />
          </div>
        )}
        {job.state === "conflict" && (
          <div className="conflict-actions">
            <code>{job.conflictPath}</code>
            <label>
              <input
                type="checkbox"
                checked={all}
                onChange={(e) => setAll(e.target.checked)}
              />
              {t.applyAll}
            </label>
            <div>
              {(["replace", "skip", "keepBoth"] as const).map((policy) => (
                <button
                  key={policy}
                  onClick={() =>
                    command("resolve_conflict", {
                      id: job.id,
                      policy,
                      all,
                    }).catch((e) => onError(String(e)))
                  }
                >
                  {t[policy]}
                </button>
              ))}
            </div>
          </div>
        )}
        {job.errors.length > 0 && (
          <details>
            <summary>
              {t.details} ({job.errors.length})
            </summary>
            <pre>{job.errors.join("\n")}</pre>
          </details>
        )}
      </div>
      {pending && (
        <IconButton
          title={t.cancel}
          onClick={() =>
            command("cancel_job", { id: job.id }).catch((e) =>
              onError(String(e)),
            )
          }
        >
          <X size={14} />
        </IconButton>
      )}
    </div>
  );
}
