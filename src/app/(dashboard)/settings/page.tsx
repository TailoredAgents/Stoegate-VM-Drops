import {
  BadgeDollarSign,
  CalendarClock,
  Phone,
  ShieldCheck,
  Users,
} from "lucide-react";
import { ProviderHealthPanel } from "@/components/provider-health-panel";
import { calculateVABenchmarks } from "@/lib/costs";
import { getAppSettings } from "@/lib/settings";
import { formatCents } from "@/lib/utils";
import { updateSettingsAction } from "./actions";

export default async function SettingsPage() {
  const settings = await getAppSettings();
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
          Sequence timing, operating limits, provider pricing, and acquisition
          benchmarks. Provider terms remain editable and billing periods retain
          pricing snapshots.
        </p>
      </div>
      <ProviderHealthPanel />
      <form action={updateSettingsAction} className="mt-6 space-y-5">
        <div className="grid gap-5 xl:grid-cols-2">
          <section className="card p-5">
            <h2 className="flex items-center gap-2 font-bold">
              <CalendarClock className="h-5 w-5 text-emerald-700" />
              Sequence operations
            </h2>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              Delays are elapsed hours from durable UTC timestamps. The timezone
              controls local operating days, windows, and billing boundaries.
            </p>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <SettingInput
                label="RVM → SMS delay (hours)"
                name="rvm_to_sms_delay_hours"
                value={settings.rvm_to_sms_delay_hours}
                step="0.25"
              />
              <SettingInput
                label="SMS → cold-call delay (hours)"
                name="sms_to_cold_call_delay_hours"
                value={settings.sms_to_cold_call_delay_hours}
                step="0.25"
              />
              <SettingInput
                label="Daily RVM operating cap"
                name="daily_rvm_cap"
                value={settings.daily_rvm_cap}
              />
              <TextInput
                label="Operations timezone"
                name="operations_timezone"
                value={settings.operations_timezone}
                placeholder="America/New_York"
              />
              <TextInput
                label="Optional send window start"
                name="rvm_send_window_start"
                value={settings.rvm_send_window_start}
                type="time"
              />
              <TextInput
                label="Optional send window end"
                name="rvm_send_window_end"
                value={settings.rvm_send_window_end}
                type="time"
              />
            </div>
          </section>

          <section className="card p-5">
            <h2 className="flex items-center gap-2 font-bold">
              <BadgeDollarSign className="h-5 w-5 text-emerald-700" />
              Drop Cowboy BYOC
            </h2>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              Current account quote: invoice = max(monthly minimum, successful
              RVMs × success price). It is not minimum plus usage; failures and
              compliance fees are $0 under this quote.
            </p>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <SettingInput
                label="Monthly minimum / credit (cents)"
                name="drop_cowboy_monthly_minimum_cents"
                value={settings.drop_cowboy_monthly_minimum_cents}
              />
              <SettingInput
                label="Cents / successful RVM"
                name="drop_cowboy_success_cost_cents"
                value={settings.drop_cowboy_success_cost_cents}
                step="0.0001"
              />
              <SettingInput
                label="Billing cycle start day"
                name="provider_billing_cycle_day"
                value={settings.provider_billing_cycle_day}
                max="28"
              />
              <SettingInput
                label="ElevenLabs cents / 1,000 chars"
                name="elevenlabs_cost_per_1000_chars_cents"
                value={settings.elevenlabs_cost_per_1000_chars_cents}
                step="0.01"
              />
              <SettingInput
                label="Optional infrastructure / month (cents)"
                name="infrastructure_monthly_overhead_cents"
                value={settings.infrastructure_monthly_overhead_cents}
              />
            </div>
          </section>

          <section className="card p-5">
            <h2 className="flex items-center gap-2 font-bold">
              <Phone className="h-5 w-5 text-emerald-700" />
              Generic carrier forecast
            </h2>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              Seeded from the current Twilio BYOC estimate. Duration remains
              explicitly estimated until actual carrier minutes are imported.
            </p>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <TextInput
                label="Carrier label"
                name="carrier_provider_name"
                value={settings.carrier_provider_name}
              />
              <SettingInput
                label="Monthly SIP trunk (cents)"
                name="carrier_trunk_monthly_cents"
                value={settings.carrier_trunk_monthly_cents}
              />
              <SettingInput
                label="Monthly cost / DID (cents)"
                name="carrier_did_monthly_cents"
                value={settings.carrier_did_monthly_cents}
                step="0.01"
              />
              <SettingInput
                label="Active RVM DIDs"
                name="carrier_active_did_count"
                value={settings.carrier_active_did_count}
              />
              <SettingInput
                label="Blended cents / minute"
                name="carrier_voice_cents_per_minute"
                value={settings.carrier_voice_cents_per_minute}
                step="0.0001"
              />
              <SettingInput
                label="Estimated seconds / attempt"
                name="carrier_average_seconds_per_attempt"
                value={settings.carrier_average_seconds_per_attempt}
                step="0.1"
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
                <p className="text-[10px] uppercase text-slate-500">
                  Deal labor
                </p>
                <strong className="text-sm">
                  {formatCents(va.vaExpectedLaborCostPerDealCents)}
                </strong>
              </div>
            </div>
          </section>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
          <div className="flex items-center gap-3">
            <ShieldCheck className="h-5 w-5 text-emerald-700" />
            <div>
              <p className="text-sm font-semibold text-emerald-900">
                Live RVM:{" "}
                {process.env.RVM_LIVE_SENDS_ENABLED === "true"
                  ? "enabled"
                  : "disabled"}
                {" · "}environment campaign cap{" "}
                {process.env.MAX_LIVE_CAMPAIGN_SEND_LIMIT ?? "10"}
                {" · "}daily cap{" "}
                {process.env.MAX_LIVE_DAILY_RVM_ATTEMPTS ?? "10"}
              </p>
              <p className="text-xs text-emerald-700">
                Environment guards remain authoritative and cannot be raised
                here.
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
  max,
}: {
  label: string;
  name: string;
  value: number;
  step?: string;
  max?: string;
}) {
  return (
    <label>
      <span className="label">{label}</span>
      <input
        className="input"
        type="number"
        min="0"
        max={max}
        step={step}
        name={name}
        defaultValue={value}
        required
      />
    </label>
  );
}

function TextInput({
  label,
  name,
  value,
  placeholder,
  type = "text",
}: {
  label: string;
  name: string;
  value: string;
  placeholder?: string;
  type?: "text" | "time";
}) {
  return (
    <label>
      <span className="label">{label}</span>
      <input
        className="input"
        type={type}
        name={name}
        defaultValue={value}
        placeholder={placeholder}
      />
    </label>
  );
}
