"use client";

import {
  Activity,
  CheckCircle2,
  CircleAlert,
  CircleDashed,
  RefreshCw,
} from "lucide-react";
import { useState } from "react";
import type { ProviderHealthResult } from "@/lib/provider-health";

export function ProviderHealthPanel() {
  const [checks, setChecks] = useState<ProviderHealthResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function runChecks() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/provider-health", {
        cache: "no-store",
      });
      const result = (await response.json()) as {
        checks?: ProviderHealthResult[];
        error?: string;
      };
      if (!response.ok || !result.checks)
        throw new Error(result.error ?? "Checks failed");
      setChecks(result.checks);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Checks failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card mt-6 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 font-bold">
            <Activity className="h-5 w-5 text-emerald-700" /> Provider health
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Harmless connectivity checks only. No audio is generated and no
            voicemail is sent.
          </p>
        </div>
        <button
          className="btn-secondary"
          type="button"
          disabled={busy}
          onClick={runChecks}
        >
          <RefreshCw className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} />{" "}
          {busy ? "Checking…" : "Run checks"}
        </button>
      </div>
      {error ? (
        <p className="mt-4 rounded-lg bg-rose-50 p-3 text-sm text-rose-700">
          {error}
        </p>
      ) : null}
      {checks.length ? (
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          {checks.map((check) => {
            const Icon =
              check.state === "healthy"
                ? CheckCircle2
                : check.state === "unhealthy"
                  ? CircleAlert
                  : CircleDashed;
            const color =
              check.state === "healthy"
                ? "text-emerald-700"
                : check.state === "unhealthy"
                  ? "text-rose-700"
                  : "text-slate-500";
            return (
              <div
                className="rounded-lg border border-slate-200 p-3"
                key={check.key}
              >
                <p
                  className={`flex items-center gap-2 text-sm font-semibold ${color}`}
                >
                  <Icon className="h-4 w-4" />
                  {check.label}
                </p>
                <p className="mt-2 text-xs leading-5 text-slate-500">
                  {check.detail}
                </p>
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
