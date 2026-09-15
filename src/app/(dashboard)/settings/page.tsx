import {
  BadgeCheck,
  BadgeDollarSign,
  CalendarClock,
  CircleAlert,
  MessageSquareText,
  RefreshCw,
  ShieldCheck,
  ShieldOff,
  Users,
  WalletCards,
} from "lucide-react";

import { requireUser } from "@/lib/auth";
import { calculateVABenchmarks } from "@/lib/costs";
import { getEnv } from "@/lib/env";
import { getAppSettings } from "@/lib/settings";
import {
  getTwilioReadinessStatus,
  type TwilioReadinessStatus,
} from "@/lib/twilio-readiness";
import { formatCents } from "@/lib/utils";
import {
  acknowledgeTwilioProductionApprovalAction,
  reconcileTwilioCostsAction,
  revokeTwilioProductionApprovalAction,
  runTwilioDiagnosticAction,
  updateSettingsAction,
} from "./actions";

export default async function SettingsPage() {
  const user = await requireUser();
  const env = getEnv();
  const [settings, twilioReadiness] = await Promise.all([
    getAppSettings(),
    user.role === "ADMIN"
      ? getTwilioReadinessStatus({ env })
      : Promise.resolve(null),
  ]);
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

      {twilioReadiness ? (
        <TwilioReadinessPanel
          status={twilioReadiness}
          timezone={settings.operations_timezone}
        />
      ) : null}

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
                label="Carrier surcharge / outbound segment (micros)"
                name="sms_carrier_surcharge_per_outbound_segment_micros"
                value={
                  settings.sms_carrier_surcharge_per_outbound_segment_micros
                }
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

function TwilioReadinessPanel({
  status,
  timezone,
}: {
  status: TwilioReadinessStatus;
  timezone: string;
}) {
  const details = status.diagnostic?.details;
  const authenticationSuccessful = typeof details?.accountStatus === "string";
  const messagingServiceFound =
    typeof details?.serviceFriendlyName === "string";
  const approvalCanBeRevoked = status.approval?.decision === "APPROVED";
  return (
    <section className="card mt-6 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 font-bold">
            {status.ready ? (
              <BadgeCheck className="h-5 w-5 text-emerald-700" />
            ) : (
              <CircleAlert className="h-5 w-5 text-amber-600" />
            )}
            Twilio production readiness
          </h2>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-slate-500">
            A recent read-only diagnostic and a separate active-admin
            acknowledgement are both required. Diagnostics inspect Twilio
            account, Messaging Service, Sender Pool, A2P registration metadata,
            and webhook configuration; they never send a message.
          </p>
        </div>
        <span
          className={`rounded-full px-3 py-1 text-xs font-bold ${
            status.ready
              ? "bg-emerald-100 text-emerald-800"
              : "bg-amber-100 text-amber-800"
          }`}
        >
          {status.ready ? "Ready" : "Blocked"}
        </span>
      </div>

      <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
        <p className="text-sm font-semibold text-slate-800">{status.reason}</p>
        <div className="mt-2 grid gap-2 text-xs text-slate-600 sm:grid-cols-2 lg:grid-cols-3">
          <p>
            Twilio credentials:{" "}
            {status.configured ? "configured" : "incomplete"}
          </p>
          <p>
            Authentication:{" "}
            {authenticationSuccessful ? "successful" : "not verified"}
          </p>
          <p>
            Messaging Service:{" "}
            {messagingServiceFound ? "found" : "not verified"}
          </p>
          <p>
            Provider selection:{" "}
            {status.providerSelected ? "Twilio" : "not Twilio"}
          </p>
          <p>
            SMS_LIVE_SENDS_ENABLED:{" "}
            {status.liveSendsEnabled ? "enabled" : "disabled"}
          </p>
          <p>
            TWILIO_PRODUCTION_APPROVED:{" "}
            {status.environmentProductionApproved ? "enabled" : "disabled"}
          </p>
          <p>
            Read-only diagnostic:{" "}
            {status.diagnosticReady ? "passing" : "required"}
          </p>
          <p>
            Admin acknowledgement:{" "}
            {status.approvalReady ? "active" : "required"}
          </p>
        </div>
        <p className="mt-2 text-xs leading-5 text-slate-500">
          Twilio-reported registration data and the admin acknowledgement are
          readiness evidence only; this panel does not independently claim
          carrier approval.
        </p>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-slate-200 p-4">
          <h3 className="text-sm font-bold text-slate-900">
            Latest diagnostic
          </h3>
          {status.diagnostic ? (
            <div className="mt-2 space-y-1 text-xs leading-5 text-slate-600">
              <p>
                <strong>{status.diagnostic.status}</strong> by{" "}
                {status.diagnostic.checkedByEmail} at{" "}
                {formatReadinessTime(status.diagnostic.checkedAt, timezone)}
              </p>
              <p>{status.diagnostic.summary}</p>
              <p>
                Account: {details?.accountStatus ?? "unknown"} · Service:{" "}
                {details?.serviceFriendlyName ?? "unknown"}
              </p>
              <p>
                Sender Pool: {details?.senderCount ?? 0} member(s),{" "}
                {details?.smsCapableSenderCount ?? 0} SMS-capable
              </p>
              <p>
                Twilio-reported registration flag:{" "}
                {String(details?.usAppToPersonRegistered ?? false)}
                {" · "}Twilio-reported campaign status:{" "}
                {details?.campaignStatuses?.join(", ") || "none"}
              </p>
              <p>
                Inbound webhook:{" "}
                {details?.inboundWebhookActual || "not configured"}
                {details?.inboundMethod ? ` (${details.inboundMethod})` : ""}
              </p>
            </div>
          ) : (
            <p className="mt-2 text-xs text-slate-500">
              No diagnostic has been recorded.
            </p>
          )}
        </div>

        <div className="rounded-lg border border-slate-200 p-4">
          <h3 className="text-sm font-bold text-slate-900">
            Production approval audit
          </h3>
          {status.approval ? (
            <div className="mt-2 space-y-1 text-xs leading-5 text-slate-600">
              <p>
                <strong>{status.approval.decision}</strong> by{" "}
                {status.approval.actorEmail} at{" "}
                {formatReadinessTime(status.approval.occurredAt, timezone)}
              </p>
              <p>
                Admin identity:{" "}
                {status.approval.actorIsActiveAdmin ? "active" : "inactive"}
                {" · "}Current configuration:{" "}
                {status.approval.configurationMatches
                  ? "matches"
                  : "does not match"}
              </p>
            </div>
          ) : (
            <p className="mt-2 text-xs text-slate-500">
              No administrator has acknowledged production approval.
            </p>
          )}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-3">
        <form action={runTwilioDiagnosticAction}>
          <button
            className="btn-secondary"
            type="submit"
            formNoValidate
            disabled={!status.configured}
          >
            <RefreshCw className="h-4 w-4" />
            Run read-only diagnostic
          </button>
        </form>
        <form action={acknowledgeTwilioProductionApprovalAction}>
          <button
            className="btn-primary"
            type="submit"
            formNoValidate
            disabled={!status.diagnosticReady || status.approvalReady}
          >
            <ShieldCheck className="h-4 w-4" />
            Acknowledge production approval
          </button>
        </form>
        <form action={revokeTwilioProductionApprovalAction}>
          <button
            className="btn-secondary border-red-200 text-red-700 hover:bg-red-50"
            type="submit"
            formNoValidate
            disabled={!approvalCanBeRevoked}
          >
            <ShieldOff className="h-4 w-4" />
            Revoke approval
          </button>
        </form>
        <form action={reconcileTwilioCostsAction}>
          <button
            className="btn-secondary"
            type="submit"
            formNoValidate
            disabled={!status.configured}
          >
            <WalletCards className="h-4 w-4" />
            Reconcile up to 25 actual Twilio costs
          </button>
        </form>
      </div>
      <p className="mt-3 text-xs text-slate-500">
        Diagnostic and cost reconciliation buttons perform bounded provider
        reads only and send nothing. Nothing runs automatically or polls Twilio.
      </p>
    </section>
  );
}

function formatReadinessTime(value: Date, timezone: string) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timezone,
  }).format(value);
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
