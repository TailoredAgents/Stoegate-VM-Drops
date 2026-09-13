import { NewCampaignWizard } from "@/components/new-campaign-wizard";
import { db } from "@/lib/db";
import { getEnv } from "@/lib/env";

export default async function NewCampaignPage() {
  const [templates, voices] = await Promise.all([
    db.scriptTemplate.findMany({
      where: { active: true },
      include: { versions: { orderBy: { version: "desc" }, take: 1 } },
      orderBy: { name: "asc" },
    }),
    db.voiceConfiguration.findMany({
      where: { active: true },
      orderBy: { name: "asc" },
    }),
  ]);
  const scripts = templates.flatMap((template) =>
    template.versions.map((version) => ({
      id: version.id,
      name: template.name,
      version: version.version,
    })),
  );
  return (
    <>
      <h1 className="text-3xl font-bold tracking-tight">New campaign</h1>
      <p className="mt-1 text-sm text-slate-500">
        Import, validate, and review outreach data before a campaign exists.
      </p>
      <NewCampaignWizard
        scripts={scripts}
        voices={voices.map((voice) => ({ id: voice.id, name: voice.name }))}
        defaultSendLimit={getEnv().DEFAULT_CAMPAIGN_SEND_LIMIT}
      />
    </>
  );
}
