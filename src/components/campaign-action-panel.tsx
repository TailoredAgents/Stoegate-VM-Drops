"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CheckCircle2, Pause, Play, RefreshCw, Volume2 } from "lucide-react";

export function CampaignActionPanel({
  id,
  name,
  status,
  eligible,
  sendLimit,
  estimatedCost,
}: {
  id: string;
  name: string;
  status: string;
  eligible: number;
  sendLimit: number;
  estimatedCost: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [ack, setAck] = useState(false);
  const [error, setError] = useState("");
  async function act(body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    const response = await fetch(`/api/campaigns/${id}/actions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) setError(result.error ?? "Action failed");
    else router.refresh();
    setBusy(false);
  }
  return (
    <div className="card p-5">
      <h2 className="font-bold">Campaign controls</h2>
      <p className="mt-1 text-sm text-slate-500">
        Approval and launch are intentionally separate.
      </p>
      {error ? (
        <p className="mt-3 rounded-lg bg-rose-50 p-3 text-sm text-rose-700">
          {error}
        </p>
      ) : null}
      {status === "DATA_READY" ||
      status === "PREVIEW_READY" ||
      status === "APPROVED" ? (
        <button
          disabled={busy}
          onClick={() => act({ action: "generate_preview" })}
          className="btn-secondary mt-4 w-full"
        >
          <Volume2 className="h-4 w-4" />
          {status === "DATA_READY"
            ? "Generate 10 previews"
            : "Regenerate preview sample"}
        </button>
      ) : null}
      {status === "PREVIEW_GENERATING" ? (
        <div className="mt-4 flex items-center gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
          <RefreshCw className="h-4 w-4 animate-spin" />
          Preview jobs are running.
        </div>
      ) : null}
      {status === "PREVIEW_READY" ? (
        <button
          disabled={busy}
          onClick={() => act({ action: "approve" })}
          className="btn-primary mt-4 w-full"
        >
          <CheckCircle2 className="h-4 w-4" />
          Approve campaign
        </button>
      ) : null}
      {status === "APPROVED" ? (
        <div className="mt-4 space-y-3 border-t border-slate-100 pt-4">
          <div className="rounded-lg bg-slate-50 p-3 text-sm">
            <div className="flex justify-between">
              <span>Eligible</span>
              <strong>{eligible.toLocaleString()}</strong>
            </div>
            <div className="mt-1 flex justify-between">
              <span>Maximum sends</span>
              <strong>{Math.min(eligible, sendLimit).toLocaleString()}</strong>
            </div>
            <div className="mt-1 flex justify-between">
              <span>Estimated cost</span>
              <strong>{estimatedCost}</strong>
            </div>
          </div>
          <label className="block">
            <span className="label">Type LAUNCH {name}</span>
            <input
              className="input"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </label>
          <label className="flex items-start gap-2 text-xs text-slate-600">
            <input
              className="mt-0.5"
              type="checkbox"
              checked={ack}
              onChange={(event) => setAck(event.target.checked)}
            />
            I understand this campaign will process no more than{" "}
            {sendLimit.toLocaleString()} contacts and that live delivery depends
            on the server safety switch.
          </label>
          <button
            disabled={busy || !ack || confirmation !== `LAUNCH ${name}`}
            onClick={() =>
              act({ action: "launch", confirmation, acknowledgeLimit: ack })
            }
            className="btn-primary w-full"
          >
            <Play className="h-4 w-4" />
            Launch campaign
          </button>
        </div>
      ) : null}
      {status === "QUEUED" || status === "SENDING" ? (
        <button
          disabled={busy}
          onClick={() => act({ action: "pause" })}
          className="btn-secondary mt-4 w-full"
        >
          <Pause className="h-4 w-4" />
          Pause new sends
        </button>
      ) : null}
      {status === "PAUSED" ? (
        <button
          disabled={busy}
          onClick={() => act({ action: "resume" })}
          className="btn-primary mt-4 w-full"
        >
          <Play className="h-4 w-4" />
          Resume campaign
        </button>
      ) : null}
    </div>
  );
}
