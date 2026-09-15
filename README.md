# Stonegate SMS Outreach

Stonegate SMS Outreach is the internal campaign workspace for Stonegate Home
Buyers. The product direction is SMS-first: import and review outreach lists,
apply suppression controls, prepare campaigns, record provider outcomes, and
hand unanswered contacts to a human cold-calling workflow.

This repository has been pivoted from an earlier voicemail product. The active
application is provider-neutral and complete for dry-run operation. A Twilio
Messaging Service adapter and signed webhook routes are installed for a future
controlled rollout, but the repository is deliberately not configured to send
live messages.

## Current safety posture

- `SMS_LIVE_SENDS_ENABLED` is `false` by default.
- `SMS_PROVIDER` is `dry-run`; no production provider credential is configured.
- `TWILIO_PRODUCTION_APPROVED` is a separate `false` environment gate.
- Checked-in live campaign and daily ceilings are both 10, independent of the
  normal 2,000-message operating target.
- A confirmed SMS send is the only event that may start the configurable
  cold-call delay. Preparing or exporting a list is not a send.
- Responses, opt-outs, DNC classifications, and wrong-number outcomes stop
  later prospecting for the normalized phone.
- These technical controls do not establish legal or regulatory compliance.
  Stonegate must complete its own consent, registration, message-content,
  quiet-hours, suppression, and jurisdiction review before any live use.

## Intended workflow

```text
Import and validate a contact/property list
  -> optionally ask OpenAI for a generic template draft
  -> review and explicitly approve an immutable template version
  -> select that version and review deterministic personalized previews
  -> approve a dry-run campaign
  -> enqueue auditable per-contact attempts at the campaign's chosen interval
  -> record sent, delivered, failed, reply, or suppression events
  -> classify replies in the compact SMS inbox
  -> after 48 elapsed hours from confirmed send with no reply, become call-eligible
  -> export a claimed, deduplicated BatchDialer CSV
  -> import human cold-call outcomes for channel attribution
```

The active implementation should remain safe when a worker restarts or a
provider repeats a webhook. PostgreSQL timestamps and idempotency keys are the
source of truth; process memory and Render disk are not.

## Architecture

- Next.js App Router with strict TypeScript for the authenticated UI and APIs
- PostgreSQL as the application system of record
- Prisma migrations and data access
- pg-boss durable work queues in the same PostgreSQL database
- Separate Render web and worker services from one repository
- Database-backed users and opaque, hashed sessions
- Provider-neutral SMS boundary with `dry-run` and a gated Twilio Messaging
  Service adapter
- Optional admin-only OpenAI assistance for generic template drafting
- Audited CSV exports/imports with immutable row snapshots

The web service validates requests and records intent. Bounded background work
runs in the worker. Generated handoff files are streamed from database
snapshots and do not depend on persistent local storage.

## Local setup

Requirements: Node.js 22.12 or newer, npm, and PostgreSQL 13 or newer (Docker
may be used for the included local database).

1. Copy `.env.example` to `.env`.
2. Replace the example session and admin values. Keep SMS in dry-run mode.
3. Start PostgreSQL with `docker compose up -d postgres`.
4. Install dependencies with `npm ci`.
5. Generate Prisma Client and apply development migrations with
   `npm run db:generate && npm run db:migrate`.
6. Create or update the initial admin with `npm run db:seed`.
7. Run the web app with `npm run dev`.
8. In another terminal, run the worker with `npm run worker:watch`.

Open `http://localhost:3000` and sign in with the configured admin account.

### Core SMS settings

| Variable                               | Checked-in value | Purpose                                                       |
| -------------------------------------- | ---------------- | ------------------------------------------------------------- |
| `SMS_LIVE_SENDS_ENABLED`               | `false`          | Environment-only live-send gate                               |
| `SMS_PROVIDER`                         | `dry-run`        | Selected adapter; change only for an approved acceptance test |
| `DEFAULT_DAILY_SMS_LIMIT`              | `2000`           | Normal editable daily operating target                        |
| `MAX_LIVE_SMS_CAMPAIGN_LIMIT`          | `10`             | Hard ceiling for one live campaign                            |
| `MAX_LIVE_DAILY_SMS_LIMIT`             | `10`             | Hard ceiling across campaigns in one operating day            |
| `DEFAULT_SMS_TO_COLD_CALL_DELAY_HOURS` | `48`             | Elapsed delay after a confirmed SMS send                      |
| `TWILIO_PRODUCTION_APPROVED`           | `false`          | Independent acknowledgement gate after real A2P approval      |

Each campaign also snapshots a configurable interval from 1 to 3,600 seconds.
Messages receive deterministic staggered schedules, and live provider
submissions for one campaign are serialized and rechecked against that
interval. If a worker or queue is delayed, overdue messages do not collapse
into a simultaneous burst.

### Optional OpenAI template drafting

OpenAI is not required to run the application. To enable drafting on the web
service, set `OPENAI_API_KEY`, keep `OPENAI_MODEL=gpt-6-astra`, and set
`OPENAI_TEMPLATE_DRAFTING_ENABLED=true`. Leave those variables off the worker;
it never calls OpenAI.

The Templates screen sends only an admin's drafting instructions and the
existing generic template body. It does not send CSV rows, contact records,
phone numbers, or property-owner data. Every generated result is stored as an
immutable, audited `DRAFT` with its model and response ID. It must pass the same
template-variable validation and receive a separate admin approval before a
campaign can select it. OpenAI is never called during campaign preparation or
message dispatch, so personalization remains deterministic and reviewable.
This feature drafts the initial SMS only; it does not create or automatically
send a multi-message follow-up sequence.

The optional Twilio configuration is `TWILIO_ACCOUNT_SID`,
`TWILIO_AUTH_TOKEN`, and `TWILIO_MESSAGING_SERVICE_SID`. The Auth Token is a
secret. The application sends through the Messaging Service Sender Pool and
does not implement its own number rotation or require a hardcoded `From`.

## Twilio readiness and webhooks

Settings includes an admin-only, read-only Twilio diagnostic. It verifies
authentication, fetches the configured Messaging Service, and inspects its
Sender Pool without sending a message. The UI distinguishes credential/service
configuration, Twilio-reported registration metadata, an audited admin
acknowledgement, and the two environment-only live gates.

Configure these public POST routes in Twilio only after the deployed
`APP_BASE_URL` is final:

- inbound messages: `/api/webhooks/twilio/inbound`
- outbound status callbacks: `/api/webhooks/twilio/status`

They accept Twilio's form-encoded payload, preserve unknown fields, and validate
`X-Twilio-Signature` with the official SDK against the trusted public URL.
Inbound requests return empty TwiML and never auto-reply. See
[TWILIO_SETUP.md](TWILIO_SETUP.md) for the human setup and controlled acceptance
sequence.

Do not add production API tokens to `.env.example`, source control, fixtures,
or documentation. Keep the Twilio Auth Token only in local secret storage and
the manually configured Render environment.

## Data import and identity

The campaign importer accepts CSV/XLSX contact and property data, normalizes US
phone numbers to E.164, retains original source rows, checks global
suppression, and keeps distinct properties associated with the same phone.
The operator explicitly maps one source column to the required `phone` field
and can map name, address, location, acreage, property type, source, and
external-ID columns. The current importer does not implement prioritized
phone-1/phone-2 fallback; select the single phone column to use for that
campaign.

Exports and outcome imports should carry Stonegate contact and campaign-contact
IDs. When several identifiers are supplied, all of them must agree. A phone or
contact that belongs to more than one campaign is not guessed for ordinary
attribution; suppression outcomes remain phone-wide.

## Outcomes and cold-call handoff

External results are previewed before commit. Provider event IDs or stable row
fingerprints make replays duplicates instead of new transitions. Meaningful
timestamps are required for send events, and a repeated send must not restart
the 48-hour clock.

Cold-call CSV creation is a handoff, not a dialer. A row becomes eligible only
after the configured delay from a confirmed SMS send and only while no reply,
lead, terminal outcome, or suppression blocks later outreach.

## SMS provider status

Twilio Programmable Messaging is the first selected production adapter, using
a Messaging Service rather than an application-managed sender rotation.
[PROVIDER_AUDIT.md](PROVIDER_AUDIT.md) records the contract, unresolved
live-account assumptions, and acceptance criteria. Twilio remains unavailable
for production traffic until the environment gates, current database-backed
diagnostic, admin acknowledgement, and per-campaign checks all pass.

## Render deployment

`render.yaml` retains the existing database, web-service, and worker resource
names so the rebrand does not replace deployed resources. Those legacy
identifiers are infrastructure handles only; they do not describe the active
product.

The Blueprint keeps SMS in provider-neutral dry-run mode and both production
gates false. `APP_BASE_URL`, admin credentials, Twilio credentials/SIDs, and the
worker session secret must be supplied manually through Render's environment
settings. Existing Blueprint resources do not automatically acquire new
`sync: false` values. The web service generates its own `SESSION_SECRET`; set a
separate 32-or-more-character value on the worker. The worker validates the
setting but does not issue or verify web login sessions.

OpenAI drafting is also off by default. If used, add `OPENAI_API_KEY` only to
the web service and then change `OPENAI_TEMPLATE_DRAFTING_ENABLED` there to
`true`. Do not add the key to source control or the worker.

Both services run the same idempotent Prisma migration command before starting,
so independently timed web and worker deploys cannot start new code against the
old schema. Render pre-deploy commands require a supported paid service plan.

## Validation

Run the following before merging or deploying a change:

```text
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:integration
npx prisma validate
npm run build
npm audit --audit-level=high
```

Run the integration command only with the explicitly disposable test database
variables documented in `.env.example`. Use `prisma migrate diff` with a
disposable shadow database for the release drift check.

## Historical implementation

The prior product is preserved for reference and rollback analysis. See
[RVM_ARCHIVE.md](RVM_ARCHIVE.md). It is not part of the active SMS runtime or
deployment configuration.
