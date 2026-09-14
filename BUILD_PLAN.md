# Stonegate VM Drops — Build Plan

## Product boundary

Stonegate VM Drops is a standalone, single-organization application for importing outreach data, rendering personalized voicemail scripts, generating and storing audio, submitting ringless voicemail drops, orchestrating external follow-up eligibility, tracking attributed outcomes, and measuring unit economics. It does not implement SMS delivery, outbound conversational calling, the human dialer, or the existing callback agent/CRM.

## Architecture decisions

- **Runtime:** strict TypeScript on Next.js App Router. The same repository runs as a Render web service and a separate `tsx` background worker.
- **Persistence:** Render PostgreSQL is the only system of record. Prisma owns application tables and migrations; pg-boss owns its queue schema in the same database. No Redis and no persistent local disk.
- **Long-running work:** HTTP requests validate, persist state, and enqueue durable jobs. The worker handles preview/bulk audio generation and delivery. Queue keys and database uniqueness constraints make work idempotent.
- **Outreach state:** campaign/audio/RVM execution status remains separate from one `OutreachSequence` projection per campaign contact. Append-only `OutreachEvent` rows explain every transition. The projection and event are committed atomically.
- **Eligibility timing:** successful live RVM delivery snapshots a configurable 24-hour SMS due timestamp. Only a confirmed external SMS send snapshots a configurable 48-hour cold-call due timestamp; failures remain retry/manual-review exceptions. A recurring pg-boss reconciler materializes due states from PostgreSQL; restarts cannot lose timers.
- **External handoffs:** SMS and BatchDialer CSV exports are authenticated POST mutations with idempotency keys, immutable row snapshots, first-export claims, and explicit audited repeat exports. CSV is streamed from PostgreSQL, never Render disk. There is no SMS provider or cold-call provider in this phase.
- **Outcome safety:** any callback/response exits later prospecting. Opt-out, provider DNC, wrong-number, lead, follow-up, contract, and closed states cannot enter downstream export queries. Export-time suppression and normalized-phone checks are defense in depth.
- **Daily operation:** a PostgreSQL ledger atomically reserves each live RVM attempt against the lower of the editable 2,000/day operating cap and the environment-only daily ceiling. Optional local send windows use an IANA timezone; deferred jobs remain durable.
- **Provider boundary:** business logic depends only on `TTSProvider`, `AudioStorageProvider`, and `RVMProvider`. ElevenLabs, Cloudflare R2, and Drop Cowboy are isolated adapters. RVM media is a typed hosted-URL/recording-ID union so transport changes stay inside the provider boundary.
- **Audio reuse:** rendered text + voice + model are hashed. Audio assets have deterministic R2 keys and unique cache constraints, so delivery retries never regenerate approved audio.
- **Imports:** uploaded CSV/XLSX data is staged in PostgreSQL, with every original row retained as JSONB. The browser receives summaries and samples only. Commit operates in chunks and links one contact/phone to any number of properties.
- **Authentication:** database-backed users, bcrypt password hashes, random opaque session tokens stored only as SHA-256 hashes, and HTTP-only same-site cookies. A bootstrap command creates the initial admin. Mutation routes enforce same-origin requests.
- **Integration API:** a constant-time API-key check protects callback lookup/result endpoints. Recent delivered drops drive deterministic matched/ambiguous responses.
- **Money:** billable ElevenLabs generation snapshots are counted once and cache/retry reuse is visible. Provider billing periods snapshot editable pricing. Drop Cowboy is modeled as `max(monthly minimum, successful usage)`, not minimum plus usage. Shared minimum and carrier fixed costs use deterministic largest-remainder allocation; sub-cent carrier rates retain fractional precision until aggregate rounding.
- **External API certainty:** provider request/response parsing uses Zod. The Drop Cowboy adapter follows its published `/v1/rvm` `audio_url` contract; live use requires Drop Cowboy approval for externally hosted audio.

## Delivery phases

1. Scaffold Next.js, validated environment configuration, Prisma schema, initial migration, and seed/bootstrap tooling.
2. Implement phone normalization, import parsing/mapping, deduplication, suppression filtering, safe Handlebars rendering, state transitions, callback matching, and analytics.
3. Add provider interfaces plus ElevenLabs, private R2, Drop Cowboy, and dry-run adapters.
4. Add pg-boss queues and an idempotent worker for preparation, audio, sending, and retries.
5. Add authenticated operational UI: dashboard, campaigns, guided import, detail/approval/launch, scripts and voices, suppression, and settings.
6. Add health, webhook, and Stonegate callback integration endpoints.
7. Add focused tests, Render Blueprint, environment template, runbook, and production checklist.
8. Add the post-RVM orchestration phase: sequence/event projection, durable 24/48-hour eligibility, external SMS tracking, BatchDialer exports, outcome imports, daily RVM ledger/window, channel attribution, monthly BYOC/carrier economics, and Today operations UI.

## Operational safeguards

- Campaigns must follow `DRAFT → DATA_READY → PREVIEW_GENERATING → PREVIEW_READY → APPROVED → QUEUED → SENDING → COMPLETED`, with explicit pause/failure paths.
- `RVM_LIVE_SENDS_ENABLED` defaults to false. `AUDIO_GENERATION_LIVE_ENABLED` can independently validate ElevenLabs/R2 without enabling RVM. Live launch requires an authenticated admin, typed confirmation, approved preview, campaign limit, and environment ceiling.
- Suppression is checked during import and again immediately before each send.
- Suppression and response outcomes also terminate every open sequence for the normalized phone; eligibility reconciliation and export queries independently require a nonterminal, unsuppressed row.
- Only the existing guarded RVM worker can call the RVM provider. The sequence reconciler has no provider dependency. Dry-run drops never enter downstream eligibility or the live daily ledger.
- `MAX_LIVE_CAMPAIGN_SEND_LIMIT` and `MAX_LIVE_DAILY_RVM_ATTEMPTS` remain environment-only hard ceilings during the 10 → small batch → 500 → 1,000 → 2,000 ramp.
- Workers use bounded concurrency, chunked queries, exponential retry backoff, structured correlation IDs, and per-contact failure recording. A durable pre-request marker makes live RVM submission at-most-once across ambiguous timeouts/restarts.
- The public provider webhook fails closed until its signing secret is configured. Raw payloads are preserved, duplicate deliveries are ignored safely, and out-of-order events cannot regress a final delivery projection; DNC still always wins.

## Production readiness gate

Before the first live send: deploy migrations, create admin credentials, confirm the outreach reconciler is scheduled, configure private R2 CORS/credentials, obtain Drop Cowboy approval for `audio_url` and exact BYOC request/account behavior, configure and test webhook signing, verify the registered brand and callback number, set real pricing, map a controlled CSV once in the external SMS tool and BatchDialer, run a consented small test list, and only then enable `RVM_LIVE_SENDS_ENABLED=true`. Twilio Messaging is not required and must not be configured for this phase.
