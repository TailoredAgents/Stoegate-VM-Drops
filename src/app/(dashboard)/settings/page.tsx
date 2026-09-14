import {
  BadgeDollarSign,
  CalendarClock,
  MessageSquareText,
  ShieldCheck,
  Users,
} from "lucide-react";

import { calculateVABenchmarks } from "@/lib/costs";
import { getEnv } from "@/lib/env";
import { getAppSettings } from "@/lib/settings";
import { formatCents } from "@/lib/utils";
import { updateSettingsAction } from "./actions";

export default async function SettingsPage() {
  const [settings, env] = await Promise.all([getAppSettings(), getEnv()]);
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
          Provider-neutral SMS limits, costs, send hours, readiness notes, and
          the human cold-calling benchmark.
        </p>
      </div>

      <form action={updateSettingsAction} className="mt-6 space-y-5">
        <div className="grid gap-5 xl:grid-cols-2">
          <section className="card p-5">
            <h2 className="flex items-center gap-2 font-bold">
              <CalendarClock className="h-5 w-5 text-emerald-700" />
              Daily operations
            </h2>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              SMS is limited by the lowest applicable campaign, application, and
              environment cap. Business-day windows use this timezone.
            </p>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <SettingInput
                label="Daily SMS operating cap"
                name="daily_sms_cap"
                value={settings.daily_sms_cap}
              />
              <SettingInput
                label="SMS to cold-call delay (hours)"
                name="sms_to_cold_call_delay_hours"
                value={settings.sms_to_cold_call_delay_hours}
              />
              <TextInput
                label="Operations timezone"
                name="operations_timezone"
                value={settings.operations_timezone}
                placeholder="America/New_York"
              />
              <div className="hidden sm:block" />
              <TextInput
                label="SMS send window starts"
                name="sms_send_window_start"
                value={settings.sms_send_window_start}
                type="time"
              />
              <TextInput
                label="SMS send window ends"
                name="sms_send_window_end"
                value={settings.sms_send_window_end}
                type="time"
              />
            </div>
          </section>

          <section className="card p-5">
            <h2 className="flex items-center gap-2 font-bold">
              <MessageSquareText className="h-5 w-5 text-emerald-700" />
              Provider readiness
            </h2>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              These fields document operational readiness; they do not make a
              campaign legally compliant or fabricate consent evidence.
            </p>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <TextInput
                label="Provider display name"
                name="sms_provider_display_name"
                value={settings.sms_provider_display_name}
              />
              <TextInput
                label="Sender identification"
                name="sms_sender_identification"
                value={settings.sms_sender_identification}
                placeholder="Brand/sender wording, if required"
              />
              <label className="sm:col-span-2">
                <span className="label">Compliance/readiness notes</span>
                <textarea
                  className="input min-h-28"
                  name="sms_compliance_notes"
                  defaultValue={settings.sms_compliance_notes}
                  placeholder="Record the reviewed requirements and evidence here."
                />
              </label>
            </div>
          </section>

          <section className="card p-5">
            <h2 className="flex items-center gap-2 font-bold">
              <BadgeDollarSign className="h-5 w-5 text-emerald-700" />
              Configurable SMS economics
            </h2>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              No carrier pricing is assumed. One cent equals 10,000 micros;
              provider-reported actual variable cost overrides estimates in
              analytics when available.
            </p>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <SettingInput
                label="Fixed provider fee / month (cents)"
                name="sms_provider_fixed_monthly_fee_cents"
                value={settings.sms_provider_fixed_monthly_fee_cents}
              />
              <SettingInput
                label="Outbound message cost (micros)"
                name="sms_cost_per_outbound_message_micros"
                value={settings.sms_cost_per_outbound_message_micros}
              />
              <SettingInput
                label="Outbound segment cost (micros)"
                name="sms_cost_per_segment_micros"
                value={settings.sms_cost_per_segment_micros}
              />
              <SettingInput
                label="Inbound message cost (micros)"
                name="sms_cost_per_inbound_message_micros"
                value={settings.sms_cost_per_inbound_message_micros}
              />
              <SettingInput
                label="Phone number / month (cents)"
                name="sms_phone_number_monthly_cents"
                value={settings.sms_phone_number_monthly_cents}
              />
              <SettingInput
                label="Registration / month (cents)"
                name="sms_registration_monthly_cents"
                value={settings.sms_registration_monthly_cents}
              />
              <SettingInput
                label="Infrastructure / month (cents)"
                name="infrastructure_monthly_overhead_cents"
                value={settings.infrastructure_monthly_overhead_cents}
              />
              <SettingInput
                label="Billing-cycle start day"
                name="provider_billing_cycle_day"
                value={settings.provider_billing_cycle_day}
                max="28"
              />
            </div>
          </section>

          <section className="card p-5">
            <h2 className="flex items-center gap-2 font-bold">
              <Users className="h-5 w-5 text-emerald-700" />
              VA cold-call benchmark
            </h2>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <SettingInput
                label="VA hourly rate (cents)"
                name="va_hourly_rate_cents"
                value={settings.va_hourly_rate_cents}
                step="0.01"
              />
              <SettingInput
                label="Real conversations / hour"
                name="va_real_conversations_per_hour"
                value={settings.va_real_conversations_per_hour}
                step="0.01"
              />
              <SettingInput
                label="Conversations / lead"
                name="va_real_conversations_per_lead"
                value={settings.va_real_conversations_per_lead}
                step="0.01"
              />
              <SettingInput
                label="Leads / deal"
                name="va_leads_per_deal"
                value={settings.va_leads_per_deal}
                step="0.01"
              />
            </div>
            <div className="mt-5 grid grid-cols-3 gap-2 rounded-lg bg-slate-50 p-3 text-center">
              <Benchmark
                label="Conversation"
                value={va.vaCostPerConversationCents}
              />
              <Benchmark
                label="Qualified lead"
                value={va.vaCostPerQualifiedLeadCents}
              />
              <Benchmark
                label="Deal labor"
                value={va.vaExpectedLaborCostPerDealCents}
              />
            </div>
          </section>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
          <div className="flex items-center gap-3">
            <ShieldCheck className="h-5 w-5 text-emerald-700" />
            <div>
              <p className="text-sm font-semibold text-emerald-950">
                Live SMS {env.SMS_LIVE_SENDS_ENABLED ? "enabled" : "disabled"}
                {" · provider "}
                {env.SMS_PROVIDER}
              </p>
              <p className="text-xs text-emerald-800">
                Environment ceilings:{" "}
                {env.MAX_LIVE_SMS_CAMPAIGN_LIMIT.toLocaleString()} per campaign
                and {env.MAX_LIVE_DAILY_SMS_LIMIT.toLocaleString()} per day.
                Environment guards cannot be raised here.
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

function Benchmark({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="text-[10px] uppercase text-slate-500">{label}</p>
      <strong className="text-sm">{formatCents(value)}</strong>
    </div>
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
