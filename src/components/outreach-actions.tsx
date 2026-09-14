"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Download, Loader2, MessageSquareText, Upload } from "lucide-react";
import type { OutreachExportPreview } from "@/lib/outreach-exports";

export interface OutreachExportScope {
  campaignId?: string;
  campaignName?: string;
  stage?: string;
  date?: string;
  source?: string;
  creditedChannel?: string;
}

export function OutreachExportControls({
  scope,
  previews,
}: {
  scope: OutreachExportScope;
  previews: {
    sms: OutreachExportPreview;
    batchDialer: OutreachExportPreview;
  };
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [repeat, setRepeat] = useState(false);
  const [repeatReason, setRepeatReason] = useState("");
  const [confirmation, setConfirmation] = useState("");

  const previewFor = (type: "SMS_ELIGIBILITY" | "BATCH_DIALER") =>
    type === "SMS_ELIGIBILITY" ? previews.sms : previews.batchDialer;
  const countFor = (type: "SMS_ELIGIBILITY" | "BATCH_DIALER") => {
    const preview = previewFor(type);
    return repeat ? preview.includingRepeatCount : preview.newCount;
  };
  const exceedsLimit = (type: "SMS_ELIGIBILITY" | "BATCH_DIALER") => {
    const preview = previewFor(type);
    return repeat ? preview.repeatExceedsLimit : preview.newExceedsLimit;
  };
  const repeatReady =
    !repeat || (repeatReason.trim().length > 0 && confirmation === "RE-EXPORT");

  async function create(type: "SMS_ELIGIBILITY" | "BATCH_DIALER") {
    setBusy(type);
    setError("");
    const response = await fetch("/api/outreach/exports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type,
        campaignId: scope.campaignId,
        stage: scope.stage,
        date: scope.date,
        source: scope.source,
        creditedChannel: scope.creditedChannel,
        idempotencyKey: crypto.randomUUID(),
        intentionalRepeat: repeat,
        repeatReason: repeat ? repeatReason : undefined,
        confirmation: repeat ? confirmation : undefined,
      }),
    });
    const result = await response.json();
    if (!response.ok) setError(result.error ?? "Could not create export");
    else {
      router.refresh();
      window.location.assign(result.downloadUrl);
    }
    setBusy(null);
  }

  return (
    <section className="card p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="font-bold">Create external handoff</h2>
          <p className="mt-1 max-w-2xl text-sm text-slate-500">
            SMS exports only record eligibility. BatchDialer exports include
            only RVM-successful contacts with a recorded SMS send and no
            response.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            className="btn-secondary"
            disabled={
              busy !== null ||
              !repeatReady ||
              countFor("SMS_ELIGIBILITY") === 0 ||
              exceedsLimit("SMS_ELIGIBILITY")
            }
            onClick={() => void create("SMS_ELIGIBILITY")}
          >
            {busy === "SMS_ELIGIBILITY" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <MessageSquareText className="h-4 w-4" />
            )}
            SMS CSV ({countFor("SMS_ELIGIBILITY").toLocaleString()})
          </button>
          <button
            className="btn-primary"
            disabled={
              busy !== null ||
              !repeatReady ||
              countFor("BATCH_DIALER") === 0 ||
              exceedsLimit("BATCH_DIALER")
            }
            onClick={() => void create("BATCH_DIALER")}
          >
            {busy === "BATCH_DIALER" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            BatchDialer CSV ({countFor("BATCH_DIALER").toLocaleString()})
          </button>
        </div>
      </div>

      <div className="mt-4 grid gap-2 rounded-lg bg-slate-50 p-3 text-xs text-slate-600 sm:grid-cols-2 lg:grid-cols-5">
        <ScopeValue
          label="Campaign"
          value={scope.campaignName ?? "All campaigns"}
        />
        <ScopeValue
          label="Stage"
          value={scope.stage?.replaceAll("_", " ") ?? "Export-required stage"}
        />
        <ScopeValue label="Event date" value={scope.date ?? "Any date"} />
        <ScopeValue label="Source" value={scope.source ?? "All sources"} />
        <ScopeValue
          label="Response channel"
          value={
            scope.creditedChannel?.replaceAll("_", " ") ?? "No channel filter"
          }
        />
      </div>
      {(previews.sms.newExceedsLimit ||
        previews.sms.repeatExceedsLimit ||
        previews.batchDialer.newExceedsLimit ||
        previews.batchDialer.repeatExceedsLimit) && (
        <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
          A matching cohort exceeds the {previews.sms.maxRows.toLocaleString()}-
          row file limit. Narrow the filters before exporting.
        </p>
      )}

      <details className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3">
        <summary className="cursor-pointer text-sm font-semibold text-amber-900">
          Intentional repeat export
        </summary>
        <label className="mt-3 flex items-center gap-2 text-sm text-amber-900">
          <input
            type="checkbox"
            checked={repeat}
            onChange={(event) => setRepeat(event.target.checked)}
          />
          Include already-exported contacts
        </label>
        {repeat ? (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label>
              <span className="label">Reason</span>
              <input
                className="input"
                value={repeatReason}
                onChange={(event) => setRepeatReason(event.target.value)}
                placeholder="Why is another handoff needed?"
              />
            </label>
            <label>
              <span className="label">Type RE-EXPORT</span>
              <input
                className="input"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
              />
            </label>
          </div>
        ) : null}
      </details>
      {error ? (
        <p className="mt-3 rounded-lg bg-rose-50 p-3 text-sm text-rose-700">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function ScopeValue({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="font-semibold text-slate-500">{label}</span>
      <p className="mt-0.5 truncate font-medium text-slate-800">{value}</p>
    </div>
  );
}

export function MarkSmsSentButton({ sequenceId }: { sequenceId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function mark() {
    setBusy(true);
    setError("");
    const response = await fetch("/api/outreach/sms/mark-sent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sequenceIds: [sequenceId],
        idempotencyKey: crypto.randomUUID(),
      }),
    });
    const result = await response.json();
    if (!response.ok) setError(result.error ?? "Could not mark sent");
    else router.refresh();
    setBusy(false);
  }
  return (
    <div>
      <button
        className="text-xs font-semibold text-emerald-700"
        disabled={busy}
        onClick={() => void mark()}
      >
        {busy ? "Saving…" : "Mark SMS sent now"}
      </button>
      {error ? <p className="mt-1 text-[11px] text-rose-700">{error}</p> : null}
    </div>
  );
}

interface OutcomePreview {
  previewToken: string;
  confirmation: string;
  total: number;
  ready: number;
  duplicates: number;
  rejected: number;
  errors: Array<{ rowNumber: number; error: string }>;
}

export function ExternalOutcomeImport() {
  const router = useRouter();
  const [channel, setChannel] = useState<"SMS" | "COLD_CALL">("SMS");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<OutcomePreview | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState<"preview" | "commit" | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  function resetPreview() {
    setPreview(null);
    setConfirmation("");
    setMessage("");
    setError("");
  }

  async function request(action: "preview" | "commit") {
    if (!file) return;
    setBusy(action);
    setError("");
    setMessage("");
    const formData = new FormData();
    formData.set("action", action);
    formData.set("channel", channel);
    formData.set("file", file);
    if (action === "commit" && preview) {
      formData.set("previewToken", preview.previewToken);
      formData.set("confirmation", confirmation);
    }
    const response = await fetch("/api/outreach/outcome-imports", {
      method: "POST",
      body: formData,
    });
    const result = await response.json();
    if (!response.ok) setError(result.error ?? "Outcome import failed");
    else if (action === "preview") setPreview(result as OutcomePreview);
    else {
      setMessage(
        `${result.accepted} accepted, ${result.duplicates} duplicates, ${result.rejected} rejected.`,
      );
      if (result.errors?.length)
        setError(
          result.errors
            .slice(0, 10)
            .map(
              (item: { rowNumber: number; error: string }) =>
                `Row ${item.rowNumber}: ${item.error}`,
            )
            .join("\n"),
        );
      setPreview(null);
      setConfirmation("");
      router.refresh();
    }
    setBusy(null);
  }

  return (
    <section className="card p-5">
      <h2 className="font-bold">Import external outcomes</h2>
      <p className="mt-1 text-sm leading-6 text-slate-500">
        Preview first, then explicitly confirm the same file. Use Stonegate
        Campaign Contact ID whenever possible. If IDs and phone are supplied,
        they must all identify the same contact. SMS sent rows require an ISO-
        8601 Sent At or Occurred At timestamp with a timezone.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-[160px_1fr_auto]">
        <select
          className="input"
          value={channel}
          onChange={(event) => {
            setChannel(event.target.value as "SMS" | "COLD_CALL");
            resetPreview();
          }}
          aria-label="Outcome channel"
        >
          <option value="SMS">SMS</option>
          <option value="COLD_CALL">Cold call</option>
        </select>
        <input
          className="input pt-2"
          type="file"
          accept=".csv"
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null);
            resetPreview();
          }}
          required
        />
        <button
          className="btn-secondary"
          disabled={busy !== null || !file}
          type="button"
          onClick={() => void request("preview")}
        >
          {busy === "preview" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Upload className="h-4 w-4" />
          )}
          Analyze CSV
        </button>
      </div>

      {preview ? (
        <div className="mt-4 rounded-lg border border-slate-200 p-4">
          <div className="grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
            {[
              ["Rows", preview.total],
              ["Ready", preview.ready],
              ["Duplicates", preview.duplicates],
              ["Rejected", preview.rejected],
            ].map(([label, value]) => (
              <div className="rounded-lg bg-slate-50 p-2" key={String(label)}>
                <p className="text-[10px] font-semibold uppercase text-slate-500">
                  {label}
                </p>
                <p className="font-bold">{Number(value).toLocaleString()}</p>
              </div>
            ))}
          </div>
          {preview.errors.length ? (
            <div className="mt-3 max-h-40 overflow-auto rounded-lg bg-rose-50 p-3 text-xs text-rose-800">
              {preview.errors.map((item) => (
                <p key={`${item.rowNumber}-${item.error}`}>
                  Row {item.rowNumber}: {item.error}
                </p>
              ))}
            </div>
          ) : null}
          <div className="mt-4 flex flex-wrap items-end gap-3">
            <label className="min-w-56 flex-1">
              <span className="label">Type {preview.confirmation}</span>
              <input
                className="input"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
              />
            </label>
            <button
              className="btn-primary"
              type="button"
              disabled={busy !== null || confirmation !== preview.confirmation}
              onClick={() => void request("commit")}
            >
              {busy === "commit" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
              Commit outcomes
            </button>
          </div>
        </div>
      ) : null}
      {message ? (
        <p className="mt-3 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">
          {message}
        </p>
      ) : null}
      {error ? (
        <p className="mt-3 whitespace-pre-line rounded-lg bg-rose-50 p-3 text-sm text-rose-700">
          {error}
        </p>
      ) : null}
    </section>
  );
}
