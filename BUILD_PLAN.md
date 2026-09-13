# Stonegate VM Drops — Build Plan

## Product boundary

Stonegate VM Drops is a standalone, single-organization application for importing outreach data, rendering personalized voicemail scripts, generating and storing audio, submitting ringless voicemail drops, tracking delivery and callback outcomes, and measuring unit economics. It does not implement outbound conversational calling or the existing callback agent/CRM.

## Architecture decisions

- **Runtime:** strict TypeScript on Next.js App Router. The same repository runs as a Render web service and a separate `tsx` background worker.
- **Persistence:** Render PostgreSQL is the only system of record. Prisma owns application tables and migrations; pg-boss owns its queue schema in the same database. No Redis and no persistent local disk.
- **Long-running work:** HTTP requests validate, persist state, and enqueue durable jobs. The worker handles preview/bulk audio generation and delivery. Queue keys and database uniqueness constraints make work idempotent.
- **Provider boundary:** business logic depends only on `TTSProvider`, `AudioStorageProvider`, and `RVMProvider`. ElevenLabs, Cloudflare R2, and Drop Cowboy are isolated adapters. RVM media is a typed hosted-URL/recording-ID union so transport changes stay inside the provider boundary.
- **Audio reuse:** rendered text + voice + model are hashed. Audio assets have deterministic R2 keys and unique cache constraints, so delivery retries never regenerate approved audio.
- **Imports:** uploaded CSV/XLSX data is staged in PostgreSQL, with every original row retained as JSONB. The browser receives summaries and samples only. Commit operates in chunks and links one contact/phone to any number of properties.
- **Authentication:** database-backed users, bcrypt password hashes, random opaque session tokens stored only as SHA-256 hashes, and HTTP-only same-site cookies. A bootstrap command creates the initial admin. Mutation routes enforce same-origin requests.
- **Integration API:** a constant-time API-key check protects callback lookup/result endpoints. Recent delivered drops drive deterministic matched/ambiguous responses.
- **Money:** stored costs are integer cents. Multi-step benchmark calculations retain fractional precision until the final displayed/stored result; editable settings hold provider rates and VA benchmarks.
- **External API certainty:** provider request/response parsing uses Zod. The Drop Cowboy adapter follows its published `/v1/rvm` `audio_url` contract; live use requires Drop Cowboy approval for externally hosted audio.

## Delivery phases

1. Scaffold Next.js, validated environment configuration, Prisma schema, initial migration, and seed/bootstrap tooling.
2. Implement phone normalization, import parsing/mapping, deduplication, suppression filtering, safe Handlebars rendering, state transitions, callback matching, and analytics.
3. Add provider interfaces plus ElevenLabs, private R2, Drop Cowboy, and dry-run adapters.
4. Add pg-boss queues and an idempotent worker for preparation, audio, sending, and retries.
5. Add authenticated operational UI: dashboard, campaigns, guided import, detail/approval/launch, scripts and voices, suppression, and settings.
6. Add health, webhook, and Stonegate callback integration endpoints.
7. Add focused tests, Render Blueprint, environment template, runbook, and production checklist.

## Operational safeguards

- Campaigns must follow `DRAFT → DATA_READY → PREVIEW_GENERATING → PREVIEW_READY → APPROVED → QUEUED → SENDING → COMPLETED`, with explicit pause/failure paths.
- `RVM_LIVE_SENDS_ENABLED` defaults to false. `AUDIO_GENERATION_LIVE_ENABLED` can independently validate ElevenLabs/R2 without enabling RVM. Live launch requires an authenticated admin, typed confirmation, approved preview, campaign limit, and environment ceiling.
- Suppression is checked during import and again immediately before each send.
- Workers use bounded concurrency, chunked queries, exponential retry backoff, structured correlation IDs, and per-contact failure recording. A durable pre-request marker makes live RVM submission at-most-once across ambiguous timeouts/restarts.
- Webhooks are authenticated when a webhook secret is configured, raw payloads are preserved, and duplicate deliveries are ignored safely.

## Production readiness gate

Before the first live send: deploy migrations, create admin credentials, configure private R2 CORS/credentials, obtain Drop Cowboy approval for `audio_url`, configure and test webhook signing, verify the registered brand and callback number, set real pricing, run a consented small test list, and only then enable `RVM_LIVE_SENDS_ENABLED=true`.
