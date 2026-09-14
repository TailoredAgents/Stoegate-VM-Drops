import Link from "next/link";
import { CampaignStatus, Prisma } from "@prisma/client";
import { Plus } from "lucide-react";
import { StatusBadge } from "@/components/status-badge";
import { db } from "@/lib/db";

export default async function CampaignsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; status?: string }>;
}) {
  const query = await searchParams;
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = 25;
  const status =
    query.status &&
    [
      "DRAFT",
      "DATA_READY",
      "PREVIEW_GENERATING",
      "PREVIEW_READY",
      "APPROVED",
      "SCHEDULED",
      "QUEUED",
      "SENDING",
      "PAUSED",
      "COMPLETED",
      "FAILED",
    ].includes(query.status)
      ? query.status
      : undefined;
  const where: Prisma.CampaignWhereInput = {
    kind: "SMS",
    ...(status ? { status: status as CampaignStatus } : {}),
  };
  const [campaigns, total] = await Promise.all([
    db.campaign.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { _count: { select: { contacts: true } } },
    }),
    db.campaign.count({ where }),
  ]);
  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Campaigns</h1>
          <p className="mt-1 text-sm text-slate-500">
            {total.toLocaleString()} campaigns across all lifecycle stages.
          </p>
        </div>
        <Link className="btn-primary" href="/campaigns/new">
          <Plus className="h-4 w-4" /> New campaign
        </Link>
      </div>
      <div className="mt-6 table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Status</th>
              <th>Uploaded</th>
              <th>Eligible</th>
              <th>Send limit</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {campaigns.map((campaign) => (
              <tr key={campaign.id}>
                <td>
                  <Link
                    className="font-semibold text-slate-950 hover:text-emerald-700"
                    href={`/campaigns/${campaign.id}`}
                  >
                    {campaign.name}
                  </Link>
                </td>
                <td>
                  <StatusBadge status={campaign.status} />
                </td>
                <td>{campaign.uploadedCount.toLocaleString()}</td>
                <td>{campaign.eligibleCount.toLocaleString()}</td>
                <td>{campaign.sendLimit.toLocaleString()}</td>
                <td>{campaign.updatedAt.toLocaleString()}</td>
              </tr>
            ))}
            {!campaigns.length ? (
              <tr>
                <td colSpan={6} className="py-12 text-center text-slate-500">
                  No campaigns found.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        {page > 1 ? (
          <Link className="btn-secondary" href={`/campaigns?page=${page - 1}`}>
            Previous
          </Link>
        ) : null}
        {page * pageSize < total ? (
          <Link className="btn-secondary" href={`/campaigns?page=${page + 1}`}>
            Next
          </Link>
        ) : null}
      </div>
    </>
  );
}
