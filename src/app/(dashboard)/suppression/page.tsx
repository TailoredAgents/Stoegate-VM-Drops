import { ShieldBan } from "lucide-react";
import { db } from "@/lib/db";
import { addSuppressionAction } from "./actions";

export default async function SuppressionPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const page = Math.max(1, Number((await searchParams).page) || 1);
  const [entries, total] = await Promise.all([
    db.suppressionEntry.findMany({
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * 50,
      take: 50,
    }),
    db.suppressionEntry.count(),
  ]);
  return (
    <>
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Suppression</h1>
        <p className="mt-1 text-sm text-slate-500">
          {total.toLocaleString()} global do-not-contact entries, checked at
          import and immediately before send.
        </p>
      </div>
      <div className="mt-6 grid gap-5 xl:grid-cols-[1fr_340px]">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Phone</th>
                <th>Reason</th>
                <th>Source</th>
                <th>Added</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td className="font-mono">{entry.normalizedPhone}</td>
                  <td>{entry.reason.replaceAll("_", " ")}</td>
                  <td>{entry.source ?? "—"}</td>
                  <td>{entry.createdAt.toLocaleString()}</td>
                </tr>
              ))}
              {!entries.length ? (
                <tr>
                  <td colSpan={4} className="py-12 text-center text-slate-500">
                    No suppressed numbers.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <form action={addSuppressionAction} className="card h-fit p-5">
          <div className="flex items-center gap-2">
            <ShieldBan className="h-5 w-5 text-emerald-700" />
            <h2 className="font-bold">Add suppression</h2>
          </div>
          <label className="mt-5 block">
            <span className="label">Phone</span>
            <input
              className="input"
              name="phone"
              placeholder="(770) 555-1234"
              required
            />
          </label>
          <label className="mt-4 block">
            <span className="label">Reason</span>
            <select className="input" name="reason" defaultValue="MANUAL">
              <option>MANUAL</option>
              <option>OPT_OUT</option>
              <option>WRONG_NUMBER</option>
              <option>PROVIDER_DNC</option>
              <option>COMPLIANCE</option>
            </select>
          </label>
          <label className="mt-4 block">
            <span className="label">Notes</span>
            <textarea className="textarea min-h-24" name="notes" />
          </label>
          <button className="btn-primary mt-4 w-full" type="submit">
            Suppress number
          </button>
        </form>
      </div>
    </>
  );
}
