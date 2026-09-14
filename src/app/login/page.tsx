import { MessageSquareText } from "lucide-react";
import { getCurrentUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import { loginAction } from "./actions";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (await getCurrentUser()) redirect("/dashboard");
  const { error } = await searchParams;
  return (
    <main className="grid min-h-screen place-items-center bg-[#0b1728] px-5">
      <div className="w-full max-w-sm">
        <div className="mb-7 flex items-center justify-center gap-3 text-white">
          <span className="grid h-11 w-11 place-items-center rounded-xl bg-emerald-500 text-[#0b1728]">
            <MessageSquareText />
          </span>
          <div>
            <p className="text-xl font-bold">Stonegate</p>
            <p className="text-xs tracking-[0.18em] text-slate-400">
              SMS OUTREACH
            </p>
          </div>
        </div>
        <form
          action={loginAction}
          className="rounded-2xl bg-white p-7 shadow-2xl shadow-black/30"
        >
          <h1 className="text-xl font-bold">Admin sign in</h1>
          <p className="mt-1 text-sm text-slate-500">
            Access campaign operations and reporting.
          </p>
          {error ? (
            <p className="mt-4 rounded-lg bg-rose-50 p-3 text-sm text-rose-700">
              Email or password is incorrect.
            </p>
          ) : null}
          <label className="mt-5 block">
            <span className="label">Email</span>
            <input
              className="input"
              name="email"
              type="email"
              autoComplete="email"
              required
            />
          </label>
          <label className="mt-4 block">
            <span className="label">Password</span>
            <input
              className="input"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </label>
          <button className="btn-primary mt-6 w-full" type="submit">
            Sign in
          </button>
        </form>
      </div>
    </main>
  );
}
