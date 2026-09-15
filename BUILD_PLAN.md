# Stonegate SMS Outreach — Build Plan

## Product boundary

Stonegate SMS Outreach is a standalone, single-organization application for
SMS campaign operations. Its target scope is contact/property import,
suppression, message review, guarded campaign execution, provider-event and
reply tracking, attributed outcomes, cold-call handoff, and operational
reporting.

It is not a conversational calling agent, a human dialer, or a general CRM.
Twilio production transport is technically prepared but remains locked until
Stonegate completes the required account, A2P, operational, and legal review.

## Migration status

The repository has pivoted from the archived voicemail implementation. Old
database names and historical records remain only where needed for safe,
non-destructive migration and rollback. They are not wired into the active SMS
execution path or presented as current provider configuration.

The previous implementation is retained at `archive/rvm-v1`; see
`RVM_ARCHIVE.md` for its source commit and status.

## Architecture decisions

- **Runtime:** strict TypeScript on Next.js App Router. Render runs one web
  service and one background worker from this repository.
- **Persistence:** PostgreSQL is the system of record. Prisma owns application
  migrations, and pg-boss owns durable work queues in the same database.
- **Durability:** state transitions, provider identities, timestamps, and
  idempotency keys are persisted. A restart must not lose scheduled work or
  duplicate a confirmed send.
- **SMS boundary:** campaign logic depends on a provider-neutral interface.
  `dry-run` remains the default; Twilio Messaging Service routing is the first
  gated production adapter.
- **Safety switches:** live Twilio sending requires
  `SMS_LIVE_SENDS_ENABLED=true`, `TWILIO_PRODUCTION_APPROVED=true`, a fresh
  passing diagnostic, and a current audited admin acknowledgement. Checked-in
  configuration keeps both environment switches false.
- **Limits:** the application enforces a normal daily target separately from
  environment-only campaign and daily live ceilings.
- **Eligibility timing:** only a confirmed SMS send may snapshot the
  configurable 48-hour cold-call due time. A queue, preview, or export is not a
  send.
- **Suppression:** import, pre-send, and outcome processing all apply global
  normalized-phone suppression. Opt-out, DNC, and wrong-number results stop
  later touches.
- **Auditing:** ordinary and intentional-repeat exports retain immutable row
  snapshots. Outcome imports use preview, explicit confirmation, stable
  identity, and duplicate detection.
- **Authentication:** database-backed users, hashed opaque sessions, role
  checks, and same-origin validation guard mutations.
- **Infrastructure:** existing Render resource identifiers remain stable during
  the product rename to avoid replacing the database or services.

## Delivery phases

1. **Complete:** preserve the previous product in `archive/rvm-v1` and record
   its source commit.
2. **Complete:** rebrand package metadata, application chrome, documentation,
   and environment templates to Stonegate SMS Outreach.
3. **Complete:** remove archived provider execution from active configuration
   and establish the provider-neutral SMS dry-run contract.
4. **Complete:** align the data model and workflow with versioned templates,
   SMS messages, attempts, provider events, replies, suppression, attribution,
   and cold-call eligibility.
5. **Complete:** prove list import, campaign review, dry-run execution, restart
   safety, idempotency, outcome import, and export behavior with focused and
   PostgreSQL integration tests.
6. **Complete:** select Twilio Messaging Services and review the official send,
   callback, inbound webhook, signature, and A2P contracts.
7. **Complete:** implement the Twilio adapter, native signed webhooks, read-only
   diagnostics, cost reconciliation support, and independent approval gate
   against the existing domain.
8. **Complete:** add per-campaign SMS pacing with deterministic schedules and a
   live dispatch-time interval guard; add optional OpenAI-assisted template
   drafting that always requires separate human approval.
9. **Pending external approval:** complete Twilio account/A2P, operational, and
   legal review, then run a
   deliberately limited live acceptance campaign before raising either hard
   ceiling.

## Required dry-run configuration

```text
SMS_LIVE_SENDS_ENABLED=false
SMS_PROVIDER=dry-run
TWILIO_PRODUCTION_APPROVED=false
DEFAULT_DAILY_SMS_LIMIT=2000
MAX_LIVE_SMS_CAMPAIGN_LIMIT=10
MAX_LIVE_DAILY_SMS_LIMIT=10
DEFAULT_SMS_TO_COLD_CALL_DELAY_HOURS=48
```

No production provider credential belongs in the repository. Twilio credential
names and blank placeholders are documented; real values remain secret.

## Operational safeguards

- Dry-run remains the default locally and on both Render services.
- Live-send authorization is admin-only and requires an explicit confirmation
  at the final campaign boundary.
- The worker rechecks the live switch, selected provider, campaign approval,
  hard limits, phone normalization, and suppression immediately before any
  future provider call.
- A durable reservation/idempotency marker is committed before ambiguous
  network work. Retries never assume an unknown provider result is safe to send
  again.
- Provider webhooks fail closed until authentication is configured and tested.
  Raw events are retained, replay is harmless, and a later low-priority event
  cannot regress a final outcome.
- Responses and suppression outcomes prevent cold-call eligibility. Repeated
  `sent` events cannot reset an already-running delay.
- Workers use bounded concurrency, chunked queries, retry backoff, and
  per-contact errors rather than one unbounded campaign transaction.
- Every campaign snapshots a 1-to-3,600-second submission interval. Scheduled
  work is staggered, and a campaign-scoped dispatch lock prevents overdue jobs
  from bursting through the provider concurrently.
- OpenAI may create only generic, audited template drafts. It receives no
  campaign contact data and has no execution path in the sending worker.
- Render disk is ephemeral and is not a source of campaign or export state.

## Twilio account gate

The adapter decision is complete. Before live acceptance, verify with the real
approved account:

- outbound API authentication and idempotency behavior;
- message and sender registration requirements;
- throughput, queueing, retry, and error semantics;
- provider message identifiers and status lifecycle;
- signed delivery, inbound reply, opt-out, and DNC events;
- timestamp precision and ordering behavior;
- account-specific pricing and reporting fields;
- sandbox/test-number support and production activation steps.

Twilio is the selected adapter, but it must not be described as production
approved or ready until these live-account checks and the application gates are
complete.

## Live-readiness gate

Before any production send, Stonegate must complete provider selection, account
setup, sender registration, webhook verification, data-retention review,
message-content review, suppression testing, monitoring, rollback planning, and
its own consent and jurisdiction analysis. These gates reduce operational risk;
they do not constitute a claim of legal compliance.

The first live campaign remains capped by both 10-message environment ceilings.
Raise a ceiling only after reviewing the prior batch's provider events,
responses, suppression behavior, timing, and costs.
