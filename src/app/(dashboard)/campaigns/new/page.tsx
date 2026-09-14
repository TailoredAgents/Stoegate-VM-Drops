import Link from "next/link";
import { NewCampaignWizard } from "@/components/new-campaign-wizard";
import { db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { getAppSettings } from "@/lib/settings";

export default async function NewCampaignPage() {
  const [templates, settings] = await Promise.all([
    db.smsTemplate.findMany({
      where: { active: true },
      include: {
        versions: {
          where: { status: "APPROVED" },
          orderBy: { version: "desc" },
          take: 1,
        },
      },
      orderBy: { name: "asc" },
    }),
    getAppSettings(),
  ]);
  const options = templates.flatMap((template) =>
    template.versions.map((version) => ({
      id: version.id,
      name: template.name,
      version: version.version,
      body: version.body,
    })),
  );
  return (
    <>
      <h1 className="text-3xl font-bold tracking-tight">New SMS campaign</h1>
      <p className="mt-1 text-sm text-slate-500">
        Import, clean, personalize, preview, approve, and schedule one SMS per
        eligible property owner.
      </p>
      {!options.length ? (
        <div className="card mt-6 p-6">
          <h2 className="font-bold">Create and approve a template first</h2>
          <p className="mt-1 text-sm text-slate-500">
            Campaigns can only be created from an approved versioned SMS
            template.
          </p>
          <Link className="btn-primary mt-4" href="/templates">
            Open SMS templates
          </Link>
        </div>
      ) : (
        <NewCampaignWizard
          templates={options}
          defaultDailyLimit={getEnv().DEFAULT_DAILY_SMS_LIMIT}
          defaultColdCallDelayHours={
            getEnv().DEFAULT_SMS_TO_COLD_CALL_DELAY_HOURS
          }
          defaultTimezone={settings.operations_timezone}
        />
      )}
    </>
  );
}
