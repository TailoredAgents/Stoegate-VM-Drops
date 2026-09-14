import Link from "next/link";
import {
  BarChart3,
  FileText,
  Gauge,
  Inbox,
  Megaphone,
  MessageSquareText,
  Settings,
  ShieldBan,
  Upload,
  Workflow,
} from "lucide-react";
import { logoutAction } from "@/app/login/actions";

const nav = [
  ["Dashboard", "/dashboard", Gauge],
  ["Campaigns", "/campaigns", Megaphone],
  ["New campaign", "/campaigns/new", Upload],
  ["Inbox", "/inbox", Inbox],
  ["SMS templates", "/templates", FileText],
  ["Operations", "/operations", Workflow],
  ["Suppression", "/suppression", ShieldBan],
  ["Settings", "/settings", Settings],
] as const;

export function AppShell({
  children,
  email,
}: {
  children: React.ReactNode;
  email: string;
}) {
  const liveSmsConfigured =
    process.env.SMS_LIVE_SENDS_ENABLED === "true" &&
    Boolean(process.env.SMS_PROVIDER) &&
    process.env.SMS_PROVIDER !== "dry-run";

  return (
    <div className="min-h-screen bg-slate-50 lg:grid lg:grid-cols-[236px_1fr]">
      <aside className="border-b border-white/10 bg-[#0b1728] text-white lg:fixed lg:inset-y-0 lg:w-[236px] lg:border-b-0 lg:border-r">
        <div className="flex h-16 items-center gap-3 border-b border-white/10 px-5">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-emerald-500 text-[#0b1728]">
            <MessageSquareText className="h-5 w-5" />
          </span>
          <div>
            <p className="text-sm font-bold leading-tight">Stonegate</p>
            <p className="text-[11px] text-slate-400">SMS OUTREACH</p>
          </div>
        </div>
        <nav className="flex gap-1 overflow-x-auto p-3 lg:block lg:space-y-1">
          {nav.map(([label, href, Icon]) => (
            <Link
              key={href}
              href={href}
              className="flex shrink-0 items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-slate-300 transition hover:bg-white/10 hover:text-white"
            >
              <Icon className="h-4 w-4" />
              {label}
            </Link>
          ))}
        </nav>
        <div className="hidden absolute inset-x-3 bottom-4 rounded-lg border border-white/10 bg-white/5 p-3 lg:block">
          <div className="flex items-center gap-2 text-xs text-slate-300">
            <BarChart3 className="h-4 w-4 text-emerald-400" />
            <span className="truncate">{email}</span>
          </div>
          <form action={logoutAction}>
            <button className="mt-3 text-xs font-semibold text-slate-400 hover:text-white">
              Sign out
            </button>
          </form>
        </div>
      </aside>
      <main className="min-w-0 lg:col-start-2">
        <header className="flex h-16 items-center justify-between border-b border-slate-200 bg-white px-5 lg:px-8">
          <p className="text-sm font-semibold text-slate-700">
            SMS campaign operations
          </p>
          <div className="flex items-center gap-2 rounded-full bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-600">
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            {liveSmsConfigured ? "Live SMS enabled" : "SMS dry-run"}
          </div>
        </header>
        <div className="mx-auto max-w-[1440px] p-5 lg:p-8">{children}</div>
      </main>
    </div>
  );
}
