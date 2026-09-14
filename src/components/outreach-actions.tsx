"use client";

import { Download, Loader2, Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import type { OutreachExportPreview } from "@/lib/outreach-exports";

export interface BatchDialerExportScope {
  campaignId?: string;
  campaignName?: string;
  date?: string;
  source?: string;
  state?: string;
  county?: string;
}

export function BatchDialerExportControls({
  scope,
  preview,
}: {
  scope: BatchDialerExportScope;
  preview: OutreachExportPreview;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [repeat, setRepeat] = useState(false);
  const [repeatReason, setRepeatReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const count = repeat ? preview.includingRepeatCount : preview.newCount;
  const exceedsLimit = repeat
    ? preview.repeatExceedsLimit
    : preview.newExceedsLimit;
  const repeatReady =
    !repeat || (repeatReason.trim().length > 0 && confirmation === "RE-EXPORT");

  async function createExport() {
    setBusy(true);
    setError("");
    const response = await fetch("/api/outreach/exports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "BATCH_DIALER",
        campaignId: scope.campaignId,
        date: scope.date,
        source: scope.source,
        state: scope.state,
        county: scope.county,
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
    setBusy(false);
  }

  return (
    <section className="card p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="font-bold">BatchDialer handoff</h2>
          <p className="mt-1 max-w-2xl text-sm text-slate-500">
            Export only contacts with a confirmed SMS send, an elapsed response
            window, no reply, no suppression, no known wrong number or lead, and
            no prior BatchDialer claim.
          </p>
        </div>
        <button
          className="btn-primary"
          type="button"
          disabled={busy || !repeatReady || count === 0 || exceedsLimit}
          onClick={() => void createExport()}
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Download className="h-4 w-4" />
          )}
          BatchDialer CSV ({count.toLocaleString()})
        </button>
      </div>

      <div className="mt-4 grid gap-2 rounded-lg bg-slate-50 p-3 text-xs text-slate-600 sm:grid-cols-2 lg:grid-cols-5">
        <ScopeValue
          label="Campaign"
          value={scope.campaignName ?? "All campaigns"}
        />
        <ScopeValue label="Eligible date" value={scope.date ?? "Any date"} />
        <ScopeValue label="Source" value={scope.source ?? "All sources"} />
        <ScopeValue label="State" value={scope.state ?? "All states"} />
        <ScopeValue label="County" value={scope.county ?? "All counties"} />
      </div>

      {exceedsLimit ? (
        <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
          This cohort exceeds the {preview.maxRows.toLocaleString()}-row file
          limit. Narrow the filters before exporting.
        </p>
      ) : null}

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
          Include contacts that already have a BatchDialer export claim
        </label>
        {repeat ? (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label>
              <span className="label">Reason</span>
              <input
                className="input"
                value={repeatReason}
                onChange={(event) => setRepeatReason(event.target.value)}
                placeholder="Why is another handoff required?"
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

interface OutcomePreview {
  previewToken: string;
  confirmation: string;
  total: number;
  ready: number;
  duplicates: number;
  rejected: number;
  errors: Array<{ rowNumber: number; error: string }>;
}

export function ColdCallOutcomeImport() {
  const router = useRouter();
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
    try {
      const formData = new FormData();
      formData.set("action", action);
      formData.set("channel", "COLD_CALL");
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
      if (!response.ok)
        setError(result.error ?? "Cold-call outcome import failed");
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
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Outcome import failed",
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card p-5">
      <h2 className="font-bold">Import BatchDialer outcomes</h2>
      <p className="mt-1 text-sm leading-6 text-slate-500">
        Analyze a CSV first, then type the generated confirmation to commit the
        same file. Use Stonegate Campaign Contact ID or Stonegate Export ID from
        the handoff whenever possible; identifiers must agree.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto]">
        <input
          className="input pt-2"
          type="file"
          accept=".csv,text/csv"
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
