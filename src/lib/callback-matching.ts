export interface CallbackCandidate {
  campaignContactId: string;
  propertyId: string | null;
  deliveredAt: Date;
}

export function selectCallbackMatch<T extends CallbackCandidate>(
  candidates: T[],
) {
  if (candidates.length === 0)
    return { status: "not_found" as const, candidates: [] as T[] };
  const latestByProperty = new Map<string, T>();
  for (const candidate of [...candidates].sort(
    (a, b) => b.deliveredAt.getTime() - a.deliveredAt.getTime(),
  )) {
    const key = candidate.propertyId ?? candidate.campaignContactId;
    if (!latestByProperty.has(key)) latestByProperty.set(key, candidate);
  }
  const unique = [...latestByProperty.values()];
  return unique.length === 1
    ? { status: "matched" as const, candidate: unique[0], candidates: unique }
    : { status: "ambiguous" as const, candidates: unique };
}

export async function lookupCallback(phone: string, lookbackDays: number) {
  const { db } = await import("@/lib/db");
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  const drops = await db.drop.findMany({
    where: {
      status: "DELIVERED",
      deliveredAt: { gte: since },
      campaignContact: { contact: { normalizedPhone: phone } },
    },
    orderBy: { deliveredAt: "desc" },
    take: 25,
    include: {
      campaignContact: {
        include: {
          contact: true,
          property: true,
          campaign: {
            include: { scriptTemplateVersion: { include: { template: true } } },
          },
        },
      },
      audioAsset: true,
    },
  });
  const candidates = drops.map((drop) => ({
    campaignContactId: drop.campaignContactId,
    propertyId: drop.campaignContact.propertyId,
    deliveredAt: drop.deliveredAt!,
    drop,
  }));
  return selectCallbackMatch(candidates);
}

export function serializeCallbackCandidate(
  candidate: Awaited<ReturnType<typeof lookupCallback>>["candidates"][number],
) {
  const { drop } = candidate;
  const cc = drop.campaignContact;
  return {
    contact_id: cc.contactId,
    campaign_contact_id: cc.id,
    campaign_id: cc.campaignId,
    campaign_name: cc.campaign.name,
    owner_name:
      cc.contact.ownerName ||
      [cc.contact.firstName, cc.contact.lastName].filter(Boolean).join(" ") ||
      null,
    phone: cc.contact.normalizedPhone,
    property_address: cc.property?.propertyAddress ?? null,
    city: cc.property?.city ?? null,
    state: cc.property?.state ?? null,
    county: cc.property?.county ?? null,
    property_type: cc.property?.propertyType ?? null,
    delivered_at: drop.deliveredAt?.toISOString() ?? null,
    script_name: cc.campaign.scriptTemplateVersion?.template.name ?? null,
    rendered_message: drop.audioAsset.renderedText,
  };
}
