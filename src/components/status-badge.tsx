import { cn } from "@/lib/utils";

const colors: Record<string, string> = {
  DRAFT: "bg-slate-100 text-slate-700",
  DATA_READY: "bg-blue-50 text-blue-700",
  PREVIEW_GENERATING: "bg-amber-50 text-amber-700",
  PREVIEW_READY: "bg-violet-50 text-violet-700",
  APPROVED: "bg-emerald-50 text-emerald-700",
  SCHEDULED: "bg-indigo-50 text-indigo-700",
  QUEUED: "bg-cyan-50 text-cyan-700",
  SENDING: "bg-blue-50 text-blue-700",
  PAUSED: "bg-amber-50 text-amber-700",
  COMPLETED: "bg-emerald-50 text-emerald-700",
  FAILED: "bg-rose-50 text-rose-700",
  DELIVERED: "bg-emerald-50 text-emerald-700",
  OPTED_OUT: "bg-orange-50 text-orange-700",
  SKIPPED: "bg-slate-100 text-slate-600",
  PENDING: "bg-slate-100 text-slate-700",
  DRY_RUN: "bg-violet-50 text-violet-700",
  SUBMITTING: "bg-blue-50 text-blue-700",
  SUBMISSION_UNKNOWN: "bg-amber-50 text-amber-800",
  ACCEPTED: "bg-cyan-50 text-cyan-700",
  SENT: "bg-blue-50 text-blue-700",
  UNDELIVERED: "bg-rose-50 text-rose-700",
  REPLIED: "bg-emerald-50 text-emerald-700",
  SUPPRESSED: "bg-orange-50 text-orange-700",
  CANCELED: "bg-slate-100 text-slate-600",
  SMS_PENDING: "bg-slate-100 text-slate-700",
  SMS_SCHEDULED: "bg-indigo-50 text-indigo-700",
  SMS_QUEUED: "bg-cyan-50 text-cyan-700",
  SMS_SENDING: "bg-blue-50 text-blue-700",
  SMS_ACCEPTED: "bg-cyan-50 text-cyan-700",
  SMS_SENT: "bg-blue-50 text-blue-700",
  SMS_DELIVERED: "bg-emerald-50 text-emerald-700",
  SMS_UNDELIVERED: "bg-rose-50 text-rose-700",
  SMS_DRY_RUN: "bg-violet-50 text-violet-700",
  SMS_REPLIED: "bg-emerald-50 text-emerald-700",
  SMS_FAILED: "bg-rose-50 text-rose-700",
  COLD_CALL_ELIGIBLE: "bg-cyan-50 text-cyan-700",
  COLD_CALL_EXPORTED: "bg-blue-50 text-blue-700",
  INTERESTED: "bg-emerald-50 text-emerald-700",
  QUALIFIED_LEAD: "bg-emerald-100 text-emerald-800",
  FOLLOW_UP: "bg-amber-50 text-amber-700",
  NOT_INTERESTED: "bg-slate-100 text-slate-600",
  WRONG_NUMBER: "bg-orange-50 text-orange-700",
  OPT_OUT: "bg-orange-50 text-orange-700",
  CONTRACT: "bg-emerald-100 text-emerald-900",
  CLOSED: "bg-emerald-200 text-emerald-950",
  PARTIAL: "bg-amber-50 text-amber-700",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-flex rounded-full px-2.5 py-1 text-[11px] font-bold tracking-wide",
        colors[status] ?? "bg-slate-100 text-slate-700",
      )}
    >
      {status.replaceAll("_", " ")}
    </span>
  );
}
