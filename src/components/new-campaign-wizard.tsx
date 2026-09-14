"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FileSpreadsheet,
  Loader2,
  MessageSquareText,
  Upload,
} from "lucide-react";
import { CANONICAL_FIELDS, type ColumnMapping } from "@/lib/import-fields";
import { prepareSmsMessage } from "@/lib/sms";

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

type TemplateOption = {
  id: string;
  name: string;
  version: number;
  body: string;
};

export function NewCampaignWizard({
  templates,
  defaultDailyLimit,
  defaultColdCallDelayHours,
  defaultTimezone,
}: {
  templates: TemplateOption[];
  defaultDailyLimit: number;
  defaultColdCallDelayHours: number;
  defaultTimezone: string;
}) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [inspect, setInspect] = useState<InspectResult | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [name, setName] = useState("");
  const [sourceName, setSourceName] = useState("");
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? "");
  const [sendLimit, setSendLimit] = useState(defaultDailyLimit);
  const [dailySendCap, setDailySendCap] = useState(defaultDailyLimit);
  const [timezone, setTimezone] = useState(defaultTimezone);
  const [scheduledLocal, setScheduledLocal] = useState("");
  const [windowStart, setWindowStart] = useState("09:00");
  const [windowEnd, setWindowEnd] = useState("20:00");
  const [coldCallDelay, setColdCallDelay] = useState(defaultColdCallDelayHours);
  const [complianceNotes, setComplianceNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selectedTemplate = templates.find((item) => item.id === templateId);
  const personalizedPreview = useMemo(() => {
    if (!selectedTemplate) return null;
    const row = inspect?.sample[0] ?? {};
    const value = (field: keyof ColumnMapping) =>
      mapping[field] ? row[mapping[field]!] || undefined : undefined;
    try {
      return prepareSmsMessage(selectedTemplate.body, {
        first_name: value("first_name"),
        owner_name: value("owner_name"),
        property_address: value("property_address"),
        street_name: value("street_name"),
        city: value("city"),
        state: value("state"),
        county: value("county"),
        acreage: value("acreage"),
        property_type: value("property_type"),
      });
    } catch {
      return null;
    }
  }, [inspect, mapping, selectedTemplate]);

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
      const base = selected.name.replace(/\.(csv|xlsx)$/i, "");
      if (!name) setName(base);
      if (!sourceName) setSourceName(base);
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
        sourceName,
        smsTemplateVersionId: templateId,
        sendLimit,
        dailySendCap,
        timezone,
        ...(scheduledLocal ? { scheduledLocal } : {}),
        sendWindowStart: windowStart,
        sendWindowEnd: windowEnd,
        coldCallDelayHours: coldCallDelay,
        complianceNotes,
      }),
    });
    const result = await response.json();
    if (!response.ok) {
      setError(result.error ?? "Could not create campaign");
      setBusy(false);
    } else router.push(`/campaigns/${result.campaignId}`);
  }

  return (
    <div className="mt-6 grid gap-5 xl:grid-cols-[1fr_380px]">
      <div className="space-y-5">
        <section className="card p-5">
          <div className="flex items-center gap-3">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-emerald-50 text-emerald-700">
              1
            </span>
            <div>
              <h2 className="font-bold">Upload property-owner list</h2>
              <p className="text-sm text-slate-500">
                CSV or XLSX, up to 100,000 rows.
              </p>
            </div>
          </div>
          <label className="mt-5 flex min-h-32 cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 text-center transition hover:border-emerald-500">
            <Upload className="h-6 w-6 text-emerald-700" />
            <span className="mt-2 text-sm font-semibold">
              {file?.name ?? "Choose a property-owner file"}
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
            <h2 className="font-bold">2. Map fields</h2>
            <p className="mt-1 text-sm text-slate-500">
              {inspect.rowCount.toLocaleString()} rows found. Phone is required.
            </p>
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
              Clean, deduplicate & suppress
            </button>
          </section>
        ) : null}

        {analysis ? (
          <section className="card p-5">
            <h2 className="font-bold">3. Review list quality</h2>
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
                <div className="rounded-lg bg-slate-50 p-3" key={String(label)}>
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
          </section>
        ) : null}

        {selectedTemplate ? (
          <section className="card p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="font-bold">Personalized SMS preview</h2>
                <p className="mt-1 text-sm text-slate-500">
                  {selectedTemplate.name} · version {selectedTemplate.version}
                </p>
              </div>
              <MessageSquareText className="h-5 w-5 text-emerald-700" />
            </div>
            <div className="mt-4 rounded-2xl rounded-bl-sm bg-emerald-700 p-4 text-sm leading-6 text-white">
              {personalizedPreview?.body ?? selectedTemplate.body}
            </div>
            {personalizedPreview ? (
              <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-600">
                <span>
                  {personalizedPreview.segments.characterCount} characters
                </span>
                <span>·</span>
                <span>
                  {personalizedPreview.segments.encoding.replace("_", "-")}
                </span>
                <span>·</span>
                <strong>
                  {personalizedPreview.segments.segmentCount} estimated segment
                  {personalizedPreview.segments.segmentCount === 1 ? "" : "s"}
                </strong>
              </div>
            ) : null}
            {personalizedPreview?.segments.isMultipart ? (
              <p className="mt-3 flex gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                Personalization makes this a multi-segment SMS. The complete
                message will be sent; it is never silently truncated.
              </p>
            ) : null}
          </section>
        ) : null}
      </div>

      <aside className="card h-fit p-5 xl:sticky xl:top-6">
        <h2 className="font-bold">SMS campaign setup</h2>
        <p className="mt-1 text-sm text-slate-500">
          Provider: dry-run until a production provider is selected.
        </p>
        {error ? (
          <p className="mt-4 rounded-lg bg-rose-50 p-3 text-sm text-rose-700">
            {error}
          </p>
        ) : null}
        <div className="mt-5 space-y-4">
          <label className="block">
            <span className="label">Campaign name</span>
            <input
              className="input"
              value={name}
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="block">
            <span className="label">Source / list</span>
            <input
              className="input"
              value={sourceName}
              maxLength={200}
              onChange={(event) => setSourceName(event.target.value)}
            />
          </label>
          <label className="block">
            <span className="label">Approved SMS template</span>
            <select
              className="input"
              value={templateId}
              onChange={(event) => setTemplateId(event.target.value)}
            >
              {templates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name} · v{template.version}
                </option>
              ))}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label>
              <span className="label">Campaign total cap</span>
              <input
                className="input"
                type="number"
                min={1}
                max={100000}
                value={sendLimit}
                onChange={(event) => setSendLimit(Number(event.target.value))}
              />
            </label>
            <label>
              <span className="label">Daily cap</span>
              <input
                className="input"
                type="number"
                min={1}
                max={100000}
                value={dailySendCap}
                onChange={(event) =>
                  setDailySendCap(Number(event.target.value))
                }
              />
            </label>
          </div>
          <label className="block">
            <span className="label">Timezone</span>
            <input
              className="input"
              value={timezone}
              onChange={(event) => setTimezone(event.target.value)}
            />
          </label>
          <label className="block">
            <span className="label">Schedule (optional, local time)</span>
            <input
              className="input"
              type="datetime-local"
              value={scheduledLocal}
              onChange={(event) => setScheduledLocal(event.target.value)}
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label>
              <span className="label">Send from</span>
              <input
                className="input"
                type="time"
                value={windowStart}
                onChange={(event) => setWindowStart(event.target.value)}
              />
            </label>
            <label>
              <span className="label">Send until</span>
              <input
                className="input"
                type="time"
                value={windowEnd}
                onChange={(event) => setWindowEnd(event.target.value)}
              />
            </label>
          </div>
          <label className="block">
            <span className="label">Cold-call delay (hours)</span>
            <input
              className="input"
              type="number"
              min={1}
              max={720}
              value={coldCallDelay}
              onChange={(event) => setColdCallDelay(Number(event.target.value))}
            />
          </label>
          <label className="block">
            <span className="label">Provider/readiness notes (optional)</span>
            <textarea
              className="textarea"
              value={complianceNotes}
              onChange={(event) => setComplianceNotes(event.target.value)}
            />
          </label>
        </div>
        <p className="mt-4 text-xs leading-5 text-slate-500">
          Campaign approval and an exact launch confirmation are still required.
          The application does not determine whether a campaign is legally
          compliant.
        </p>
        <button
          className="btn-primary mt-5 w-full"
          disabled={
            busy || !analysis || !name || !templateId || !templates.length
          }
          onClick={() => void commit()}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Create data-ready campaign
        </button>
      </aside>
    </div>
  );
}
