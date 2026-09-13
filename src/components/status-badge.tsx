import { cn } from "@/lib/utils";

const colors: Record<string, string> = {
  DRAFT: "bg-slate-100 text-slate-700",
  DATA_READY: "bg-blue-50 text-blue-700",
  PREVIEW_GENERATING: "bg-amber-50 text-amber-700",
  PREVIEW_READY: "bg-violet-50 text-violet-700",
  APPROVED: "bg-emerald-50 text-emerald-700",
  QUEUED: "bg-cyan-50 text-cyan-700",
  SENDING: "bg-blue-50 text-blue-700",
  PAUSED: "bg-amber-50 text-amber-700",
  COMPLETED: "bg-emerald-50 text-emerald-700",
  FAILED: "bg-rose-50 text-rose-700",
  DELIVERED: "bg-emerald-50 text-emerald-700",
  OPTED_OUT: "bg-orange-50 text-orange-700",
  SKIPPED: "bg-slate-100 text-slate-600",
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
