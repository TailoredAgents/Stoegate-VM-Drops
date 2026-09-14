"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  CheckCircle2,
  MessageSquareText,
  Pause,
  Play,
  RefreshCw,
} from "lucide-react";

export function CampaignActionPanel({
  id,
  name,
  status,
  eligible,
  sendLimit,
  dailyCap,
  estimatedCost,
  liveSms,
}: {
  id: string;
  name: string;
  status: string;
  eligible: number;
  sendLimit: number;
  dailyCap: number;
  estimatedCost: string;
  liveSms: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [ack, setAck] = useState(false);
  const [readinessAck, setReadinessAck] = useState(false);
  const [error, setError] = useState("");

  async function act(body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    const response = await fetch("/api/campaigns/" + id + "/actions", {
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
        Preview, operational approval, and launch are separate safeguards.
      </p>
      {error ? (
        <p className="mt-3 rounded-lg bg-rose-50 p-3 text-sm text-rose-700">
          {error}
        </p>
      ) : null}
      {["DATA_READY", "PREVIEW_READY", "APPROVED"].includes(status) ? (
        <button
          disabled={busy}
          onClick={() => void act({ action: "generate_preview" })}
          className="btn-secondary mt-4 w-full"
        >
          <MessageSquareText className="h-4 w-4" />
          {status === "DATA_READY"
            ? "Render preview sample"
            : "Regenerate preview sample"}
        </button>
      ) : null}
      {status === "PREVIEW_GENERATING" ? (
        <div className="mt-4 flex items-center gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
          <RefreshCw className="h-4 w-4 animate-spin" />
          Personalized previews are being rendered.
        </div>
      ) : null}
      {status === "PREVIEW_READY" ? (
        <div className="mt-4 space-y-3">
          <label className="flex items-start gap-2 text-xs text-slate-600">
            <input
              className="mt-0.5"
              type="checkbox"
              checked={readinessAck}
              onChange={(event) => setReadinessAck(event.target.checked)}
            />
            I reviewed the template, personalization, suppression controls, send
            window, and provider-readiness notes. This is an operational review,
            not a legal-compliance determination.
          </label>
          <button
            disabled={busy || !readinessAck}
            onClick={() =>
              void act({
                action: "approve",
                acknowledgeReadiness: readinessAck,
              })
            }
            className="btn-primary w-full"
          >
            <CheckCircle2 className="h-4 w-4" />
            Approve campaign
          </button>
        </div>
      ) : null}
      {status === "APPROVED" ? (
        <div className="mt-4 space-y-3 border-t border-slate-100 pt-4">
          <div className="rounded-lg bg-slate-50 p-3 text-sm">
            <div className="flex justify-between">
              <span>Eligible</span>
              <strong>{eligible.toLocaleString()}</strong>
            </div>
            <div className="mt-1 flex justify-between">
              <span>Total cap</span>
              <strong>{Math.min(eligible, sendLimit).toLocaleString()}</strong>
            </div>
            <div className="mt-1 flex justify-between">
              <span>Daily cap</span>
              <strong>{dailyCap.toLocaleString()}</strong>
            </div>
            <div className="mt-1 flex justify-between">
              <span>Estimated variable cost</span>
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
            I understand the campaign limits and that{" "}
            {liveSms
              ? "the server is configured for live SMS"
              : "this launch is a dry run and sends no SMS"}
            .
          </label>
          <button
            disabled={busy || !ack || confirmation !== "LAUNCH " + name}
            onClick={() =>
              void act({
                action: "launch",
                confirmation,
                acknowledgeLimit: ack,
              })
            }
            className="btn-primary w-full"
          >
            <Play className="h-4 w-4" />
            {liveSms ? "Launch SMS campaign" : "Launch dry run"}
          </button>
        </div>
      ) : null}
      {["SCHEDULED", "QUEUED", "SENDING"].includes(status) ? (
        <button
          disabled={busy}
          onClick={() => void act({ action: "pause" })}
          className="btn-secondary mt-4 w-full"
        >
          <Pause className="h-4 w-4" />
          Pause new sends
        </button>
      ) : null}
      {status === "PAUSED" ? (
        <button
          disabled={busy}
          onClick={() => void act({ action: "resume" })}
          className="btn-primary mt-4 w-full"
        >
          <Play className="h-4 w-4" />
          Resume campaign
        </button>
      ) : null}
    </div>
  );
}
