"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FileSpreadsheet,
  Loader2,
  Upload,
} from "lucide-react";
import { CANONICAL_FIELDS, type ColumnMapping } from "@/lib/import-fields";

interface InspectResult {
  rowCount: number;
  headers: string[];
  suggestedMapping: ColumnMapping;
  sample: Record<string, string>[];
}
interface AnalysisResult {
  batchId: string;
  summary: {
    uploaded: number;
    eligible: number;
    duplicate: number;
    suppressed: number;
    invalid: number;
    missing: number;
  };
  sampleIssues: Array<{
    rowNumber: number;
    status: string;
    errorMessage: string;
  }>;
}

export function NewCampaignWizard({
  scripts,
  voices,
  defaultSendLimit,
}: {
  scripts: Array<{ id: string; name: string; version: number }>;
  voices: Array<{ id: string; name: string }>;
  defaultSendLimit: number;
}) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [inspect, setInspect] = useState<InspectResult | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [name, setName] = useState("");
  const [scriptId, setScriptId] = useState(scripts[0]?.id ?? "");
  const [voiceId, setVoiceId] = useState(voices[0]?.id ?? "");
  const [sendLimit, setSendLimit] = useState(defaultSendLimit);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function inspectFile(selected: File) {
    setFile(selected);
    setAnalysis(null);
    setBusy(true);
    setError("");
    const body = new FormData();
    body.set("file", selected);
    const response = await fetch("/api/imports/inspect", {
      method: "POST",
      body,
    });
    const result = await response.json();
    if (!response.ok) setError(result.error ?? "Could not inspect file");
    else {
      setInspect(result);
      setMapping(result.suggestedMapping);
      if (!name) setName(selected.name.replace(/\.(csv|xlsx)$/i, ""));
    }
    setBusy(false);
  }
  async function analyze() {
    if (!file) return;
    setBusy(true);
    setError("");
    const body = new FormData();
    body.set("file", file);
    body.set("mapping", JSON.stringify(mapping));
    const response = await fetch("/api/imports/analyze", {
      method: "POST",
      body,
    });
    const result = await response.json();
    if (!response.ok) setError(result.error ?? "Could not analyze file");
    else setAnalysis(result);
    setBusy(false);
  }
  async function commit() {
    if (!analysis) return;
    setBusy(true);
    setError("");
    const response = await fetch("/api/imports/commit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        batchId: analysis.batchId,
        campaignName: name,
        scriptTemplateVersionId: scriptId,
        voiceConfigurationId: voiceId,
        sendLimit,
      }),
    });
    const result = await response.json();
    if (!response.ok) {
      setError(result.error ?? "Could not create campaign");
      setBusy(false);
    } else router.push(`/campaigns/${result.campaignId}`);
  }
  return (
    <div className="mt-6 grid gap-5 xl:grid-cols-[1fr_360px]">
      <div className="space-y-5">
        <section className="card p-5">
          <div className="flex items-center gap-3">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-emerald-50 text-emerald-700">
              1
            </span>
            <div>
              <h2 className="font-bold">Upload source list</h2>
              <p className="text-sm text-slate-500">
                CSV or XLSX, up to 100,000 rows.
              </p>
            </div>
          </div>
          <label className="mt-5 flex min-h-32 cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 text-center transition hover:border-emerald-500">
            <Upload className="h-6 w-6 text-emerald-700" />
            <span className="mt-2 text-sm font-semibold">
              {file?.name ?? "Choose an outreach file"}
            </span>
            <span className="mt-1 text-xs text-slate-500">
              Original rows are retained for audit.
            </span>
            <input
              className="sr-only"
              type="file"
              accept=".csv,.xlsx"
              onChange={(event) =>
                event.target.files?.[0] &&
                void inspectFile(event.target.files[0])
              }
            />
          </label>
        </section>
        {inspect ? (
          <section className="card p-5">
            <div className="flex items-center gap-3">
              <span className="grid h-9 w-9 place-items-center rounded-lg bg-emerald-50 text-emerald-700">
                2
              </span>
              <div>
                <h2 className="font-bold">Map columns</h2>
                <p className="text-sm text-slate-500">
                  {inspect.rowCount.toLocaleString()} data rows found. Phone is
                  required.
                </p>
              </div>
            </div>
            <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {CANONICAL_FIELDS.map((field) => (
                <label key={field}>
                  <span className="label">
                    {field.replaceAll("_", " ")}
                    {field === "phone" ? " *" : ""}
                  </span>
                  <select
                    className="input"
                    value={mapping[field] ?? ""}
                    onChange={(event) => {
                      setMapping((current) => ({
                        ...current,
                        [field]: event.target.value || undefined,
                      }));
                      setAnalysis(null);
                    }}
                  >
                    <option value="">Not mapped</option>
                    {inspect.headers.map((header) => (
                      <option key={header} value={header}>
                        {header}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            <button
              className="btn-primary mt-5"
              disabled={busy || !mapping.phone}
              onClick={() => void analyze()}
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <FileSpreadsheet className="h-4 w-4" />
              )}
              Analyze & apply suppression
            </button>
          </section>
        ) : null}
        {analysis ? (
          <section className="card p-5">
            <div className="flex items-center gap-3">
              <span className="grid h-9 w-9 place-items-center rounded-lg bg-emerald-50 text-emerald-700">
                3
              </span>
              <div>
                <h2 className="font-bold">Review import summary</h2>
                <p className="text-sm text-slate-500">
                  Nothing has been committed to a campaign yet.
                </p>
              </div>
            </div>
            <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-5">
              {[
                ["Uploaded", analysis.summary.uploaded],
                ["Eligible", analysis.summary.eligible],
                ["Duplicate", analysis.summary.duplicate],
                ["Suppressed", analysis.summary.suppressed],
                [
                  "Invalid",
                  analysis.summary.invalid + analysis.summary.missing,
                ],
              ].map(([label, value]) => (
                <div
                  className={`rounded-lg p-3 ${label === "Eligible" ? "bg-emerald-50" : "bg-slate-50"}`}
                  key={String(label)}
                >
                  <p className="text-xs text-slate-500">{label}</p>
                  <p className="mt-1 text-xl font-bold">
                    {Number(value).toLocaleString()}
                  </p>
                </div>
              ))}
            </div>
            <div className="mt-4 flex items-center gap-2 rounded-lg bg-emerald-50 p-3 text-sm font-semibold text-emerald-800">
              <CheckCircle2 className="h-4 w-4" />
              {analysis.summary.eligible.toLocaleString()} contacts are
              eligible.
            </div>
            {analysis.sampleIssues.length ? (
              <details className="mt-3 text-sm text-slate-600">
                <summary className="cursor-pointer font-semibold">
                  View sample issues
                </summary>
                <ul className="mt-2 space-y-1">
                  {analysis.sampleIssues.map((issue) => (
                    <li key={`${issue.rowNumber}-${issue.status}`}>
                      Row {issue.rowNumber}: {issue.errorMessage}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </section>
        ) : null}
      </div>
      <aside className="card h-fit p-5 xl:sticky xl:top-6">
        <h2 className="font-bold">Campaign setup</h2>
        <p className="mt-1 text-sm text-slate-500">
          Configure the approved version used for every recipient.
        </p>
        {error ? (
          <div className="mt-4 flex gap-2 rounded-lg bg-rose-50 p-3 text-sm text-rose-700">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            {error}
          </div>
        ) : null}
        <label className="mt-5 block">
          <span className="label">Campaign name</span>
          <input
            className="input"
            value={name}
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="mt-4 block">
          <span className="label">Script version</span>
          <select
            className="input"
            value={scriptId}
            onChange={(event) => setScriptId(event.target.value)}
          >
            {scripts.map((script) => (
              <option key={script.id} value={script.id}>
                {script.name} · v{script.version}
              </option>
            ))}
          </select>
        </label>
        <label className="mt-4 block">
          <span className="label">ElevenLabs voice</span>
          <select
            className="input"
            value={voiceId}
            onChange={(event) => setVoiceId(event.target.value)}
          >
            {voices.map((voice) => (
              <option key={voice.id} value={voice.id}>
                {voice.name}
              </option>
            ))}
          </select>
        </label>
        <label className="mt-4 block">
          <span className="label">Maximum sends</span>
          <input
            className="input"
            type="number"
            min={1}
            max={100000}
            value={sendLimit}
            onChange={(event) => setSendLimit(Number(event.target.value))}
          />
        </label>
        <p className="mt-3 text-xs leading-5 text-slate-500">
          The campaign cannot exceed this limit. Preview approval is required
          before launch.
        </p>
        <button
          className="btn-primary mt-5 w-full"
          disabled={busy || !analysis || !name || !scriptId || !voiceId}
          onClick={() => void commit()}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Create
          data-ready campaign
        </button>
      </aside>
    </div>
  );
}
