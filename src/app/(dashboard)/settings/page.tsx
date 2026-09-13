import { BadgeDollarSign, ShieldCheck, Users } from "lucide-react";
import { ProviderHealthPanel } from "@/components/provider-health-panel";
import { calculateVABenchmarks } from "@/lib/costs";
import { getNumericSettings } from "@/lib/settings";
import { formatCents } from "@/lib/utils";
import { updateSettingsAction } from "./actions";

export default async function SettingsPage() {
  const settings = await getNumericSettings();
  const va = calculateVABenchmarks({
    hourlyRateCents: settings.va_hourly_rate_cents,
    realConversationsPerHour: settings.va_real_conversations_per_hour,
    realConversationsPerLead: settings.va_real_conversations_per_lead,
    leadsPerDeal: settings.va_leads_per_deal,
  });

  return (
    <>
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-slate-500">
          Editable provider pricing and acquisition benchmarks. All currency
          values use cents.
        </p>
      </div>
      <ProviderHealthPanel />
      <form
        action={updateSettingsAction}
        className="mt-6 grid gap-5 xl:grid-cols-2"
      >
        <section className="card p-5">
          <h2 className="flex items-center gap-2 font-bold">
            <BadgeDollarSign className="h-5 w-5 text-emerald-700" />
            Provider economics
          </h2>
          <div className="mt-5 space-y-4">
            <SettingInput
              label="ElevenLabs cents / 1,000 characters"
              name="elevenlabs_cost_per_1000_chars_cents"
              value={settings.elevenlabs_cost_per_1000_chars_cents}
              step="0.01"
            />
            <SettingInput
              label="Drop Cowboy cents / delivered drop"
              name="rvm_cost_per_delivered_drop_cents"
              value={settings.rvm_cost_per_delivered_drop_cents}
              step="0.01"
            />
            <SettingInput
              label="Compliance/provider cents / attempted message"
              name="compliance_cost_per_message_cents"
              value={settings.compliance_cost_per_message_cents}
              step="0.01"
            />
          </div>
        </section>
        <section className="card p-5">
          <h2 className="flex items-center gap-2 font-bold">
            <Users className="h-5 w-5 text-emerald-700" />
            VA benchmarks
          </h2>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <SettingInput
              label="VA hourly rate (cents)"
              name="va_hourly_rate_cents"
              value={settings.va_hourly_rate_cents}
            />
            <SettingInput
              label="Real conversations / hour"
              name="va_real_conversations_per_hour"
              value={settings.va_real_conversations_per_hour}
            />
            <SettingInput
              label="Conversations / lead"
              name="va_real_conversations_per_lead"
              value={settings.va_real_conversations_per_lead}
            />
            <SettingInput
              label="Leads / deal"
              name="va_leads_per_deal"
              value={settings.va_leads_per_deal}
            />
          </div>
          <div className="mt-5 grid grid-cols-3 gap-2 rounded-lg bg-slate-50 p-3 text-center">
            <div>
              <p className="text-[10px] uppercase text-slate-500">
                Conversation
              </p>
              <strong className="text-sm">
                {formatCents(va.vaCostPerConversationCents)}
              </strong>
            </div>
            <div>
              <p className="text-[10px] uppercase text-slate-500">Lead</p>
              <strong className="text-sm">
                {formatCents(va.vaCostPerQualifiedLeadCents)}
              </strong>
            </div>
            <div>
              <p className="text-[10px] uppercase text-slate-500">Deal labor</p>
              <strong className="text-sm">
                {formatCents(va.vaExpectedLaborCostPerDealCents)}
              </strong>
            </div>
          </div>
        </section>
        <div className="flex items-center justify-between rounded-xl border border-emerald-200 bg-emerald-50 p-4 xl:col-span-2">
          <div className="flex items-center gap-3">
            <ShieldCheck className="h-5 w-5 text-emerald-700" />
            <div>
              <p className="text-sm font-semibold text-emerald-900">
                Live provider switch:{" "}
                {process.env.RVM_LIVE_SENDS_ENABLED === "true"
                  ? "enabled"
                  : "disabled"}
              </p>
              <p className="text-xs text-emerald-700">
                This safety control is environment-only and cannot be changed in
                the UI.
              </p>
            </div>
          </div>
          <button className="btn-primary" type="submit">
            Save settings
          </button>
        </div>
      </form>
    </>
  );
}

function SettingInput({
  label,
  name,
  value,
  step = "1",
}: {
  label: string;
  name: string;
  value: number;
  step?: string;
}) {
  return (
    <label>
      <span className="label">{label}</span>
      <input
        className="input"
        type="number"
        min="0"
        step={step}
        name={name}
        defaultValue={value}
        required
      />
    </label>
  );
}
