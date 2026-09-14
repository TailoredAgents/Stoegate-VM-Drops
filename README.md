# Stonegate VM Drops

Standalone internal application for personalized ringless voicemail campaigns and post-RVM outreach orchestration at Stonegate Home Buyers. It imports and validates contact/property data, generates approved personalized audio, sends through an abstracted RVM provider, consumes delivery events, coordinates external SMS and human cold-call handoffs, accepts attributed outcomes, and reports campaign economics.

This project intentionally does **not** implement an outbound conversational caller, callback voice agent, SMS sender, or cold-call dialer.

## Architecture

- Next.js App Router + strict TypeScript for the UI and HTTP APIs
- PostgreSQL as the only primary database
- Prisma migrations and application data access
- pg-boss durable PostgreSQL jobs for preview generation, bulk generation, and delivery
- A queryable `OutreachSequence` projection plus append-only `OutreachEvent` ledger for every multi-touch transition
- Audited, duplicate-protected CSV handoffs; generated files are streamed from PostgreSQL snapshots and never written to Render disk
- Separate Render web and worker processes from one repository
- Provider interfaces with ElevenLabs, private Cloudflare R2, Drop Cowboy, and safe dry-run implementations
- Database-backed admin users and opaque, hashed sessions

The web process never performs long-running generation or RVM delivery. It validates requests, commits state, and enqueues work. The worker processes bounded jobs independently and records per-recipient errors.

## Outreach sequence

The production sequence is deliberately split into execution state and outreach state. `Campaign.status` and `CampaignContact.status` continue to describe campaign approval, audio, and RVM execution. `OutreachSequence.currentState` is the deterministic projection for later touches, while every cause is retained in `OutreachEvent` with its timestamp, source, external ID/raw payload where available, resulting state, actor, and idempotency key.

```text
RVM_PENDING
  → genuine live RVM submission
RVM_SENT
  → successful Drop Cowboy delivery webhook
SMS_NOT_YET_ELIGIBLE
  → 24 elapsed hours with no response (editable)
SMS_ELIGIBLE
  → audited CSV handoff
SMS_EXPORTED
  → operator/import records the real external send timestamp
SMS_SENT_EXTERNAL
  → 48 elapsed hours with no response (editable)
COLD_CALL_ELIGIBLE
  → audited BatchDialer CSV handoff
COLD_CALL_EXPORTED
```

The database timestamps are the source of truth. A pg-boss schedule runs the idempotent reconciliation job every minute; a new worker catches all overdue rows after downtime, so no in-memory timer or always-on web process is required. Eligibility delays are elapsed UTC time. The configured IANA timezone controls local-day counters, optional send windows, and billing-period boundaries.

Only a genuine, non-dry-run RVM success begins the SMS timer. Exporting an SMS CSV does not imply consent or sending and does not begin the cold-call timer. Only a confirmed `SMS_SENT_EXTERNAL` timestamp begins the 48-hour clock; an SMS failure remains an exception/retry state and never advances to cold-call eligibility. RVM failures do not automatically advance because the contact did not receive the intended sequence.

Every supported human response exits prospecting: callback, interested, qualified lead, follow-up, not interested, wrong number, opt-out, contract, or closed. Opt-out/provider DNC and wrong-number results also update global suppression. Qualified/interested/contract/closed results retain immutable first-touch lead attribution as `RVM_CALLBACK`, `SMS`, `COLD_CALL`, or `OTHER`.

## External SMS and BatchDialer handoffs

The authenticated **Outreach** workspace shows today’s RVM progress, SMS/cold-call eligibility, responses, filters, sequence rows, export history, and outcome-import history. It can:

- Create an SMS eligibility CSV without sending a message.
- Mark an exported row `SMS_SENT_EXTERNAL` with the real timestamp.
- Create a BatchDialer-ready CSV only from `COLD_CALL_ELIGIBLE` rows that had a successful RVM, a confirmed external SMS send, no response/lead/suppression, a valid normalized phone, and no prior ordinary export.
- Intentionally repeat an export only with admin confirmation and a recorded reason.
- Import external SMS or cold-call outcomes from CSV.

BatchDialer exports include name/owner, normalized phone, property/address fields, source, campaign, RVM/SMS timestamps, Stonegate contact and campaign-contact IDs, export ID, and stable `Original - …` columns from the source row. The campaign-contact ID is the safest key for same-phone/multiple-property outcomes. CSV text cells are protected against spreadsheet-formula injection.

External outcome CSVs accept these common headings (case/punctuation insensitive):

```text
Stonegate Campaign Contact ID | Stonegate Contact ID | Phone
Result | Occurred At | External ID
Sent At | Responded At | Contacted At
```

SMS results: `sent`, `reply`, `interested`, `qualified lead`, `not interested`, `opt out`, `wrong number`, or `failed`. Cold-call results additionally support `contacted`, `DNC`, and `no answer`. Matching prefers campaign-contact ID, then contact ID, then phone; when more than one identifier is supplied, all of them must agree, and ambiguous contact/phone matches are rejected rather than guessed. Imports require a read-only preview and a typed confirmation of the unchanged file. SMS `sent` rows require an ISO-8601 timestamp with a timezone. Stable row fingerprints or external IDs make re-imports auditable duplicates instead of restarting timers. Every committed row is retained with accepted/duplicate/rejected status.

## Local setup

Requirements: Node.js 22.12+, npm, Docker (or PostgreSQL 13+).

1. Copy `.env.example` to `.env` and replace the session/integration secrets and admin credentials.
2. Start PostgreSQL: `docker compose up -d postgres`.
3. Install dependencies: `npm ci`.
4. Generate the client and migrate: `npm run db:generate && npm run db:migrate`.
5. Create/update the first admin, starter script, voice, and settings: `npm run db:seed`.
6. Run the web app: `npm run dev`.
7. In another terminal run the worker: `npm run worker:watch`.

Open `http://localhost:3000` and sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD` from the seed step.

### Database commands

- `npm run db:migrate` creates and applies development migrations.
- `npm run db:deploy` applies committed migrations in production.
- `npm run db:seed` idempotently creates the admin, default benchmarks, starter script, and voice.
- pg-boss manages its own schema inside the same PostgreSQL database when the web or worker first enqueues/starts.

The outreach migration conservatively creates an inert `RVM_PENDING` sequence for existing campaign contacts; it does not infer a successful historical delivery or start a timer. It backfills reporting attribution only where one earliest historical qualifying outcome is unambiguous. Existing generated audio receives one matching usage-ledger record, while future live generation is recorded before object storage.

Prisma 6.12 is intentionally pinned because the newer CLI release available during this build contained high-severity transitive audit advisories. Runtime dependencies currently audit clean.

## Dry-run workflow

`RVM_LIVE_SENDS_ENABLED=false` is the default and is the only setting that permits a real voicemail request. Audio validation is intentionally independent:

- With `AUDIO_GENERATION_LIVE_ENABLED=false`, ElevenLabs/R2 are replaced by a local preview tone and simulated storage.
- With `AUDIO_GENERATION_LIVE_ENABLED=true`, previews and bulk assets use real ElevenLabs and private R2 even though voicemail remains simulated.
- Drop Cowboy is not contacted; each attempted delivery is recorded as `DRY_RUN`.
- Dry-run deliveries never start post-RVM eligibility or consume the live daily-attempt ledger.
- When real audio is later enabled, a ready dry-run tone is regenerated instead of reused. A live RVM reservation requires an immutable billable-generation record whose R2 storage completed successfully.
- Campaign state, imports, templates, preview approval, job processing, callback APIs, and analytics remain testable.

A campaign must be imported and reach `DATA_READY`, generate previews, reach `PREVIEW_READY`, be explicitly approved, and then pass a typed launch confirmation. The per-campaign send limit is enforced independently of the live-send switch.

## Imports

The New Campaign wizard accepts `.csv` and `.xlsx` files up to 25 MB / 100,000 data rows. It provides column mapping for:

`phone`, `first_name`, `last_name`, `owner_name`, `property_address`, `street_name`, `city`, `state`, `postal_code`, `county`, `acreage`, `property_type`, `source`, and `external_id`.

Phone is required and normalized to US E.164. Exact phone/property duplicates are excluded. The same phone with distinct properties remains eligible by design. The global suppression list is applied during analysis and again immediately before delivery. Every original row is retained in PostgreSQL JSONB.

## Templates and voices

Scripts use Handlebars. Standard conditionals avoid broken copy when a field is absent:

```handlebars
Hi
{{#if first_name}}{{first_name}}{{else}}{{owner_name}}{{/if}}, I was reaching
out{{#if street_name}} about the property on {{street_name}}{{/if}}.
```

Edits create immutable script versions. Campaigns and audio assets reference the exact selected version. Voice IDs and model IDs are stored in `VoiceConfiguration`; the environment values seed the initial voice but are not hardcoded into campaign logic.

## ElevenLabs

Set `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL_ID`, and `ELEVENLABS_OUTPUT_FORMAT`. The adapter calls `POST /v1/text-to-speech/{voice_id}` with `xi-api-key`, JSON `text`, `model_id`, optional `voice_settings`, and an explicit `output_format=mp3_44100_128` by default. It stores the `request-id` and billed `character-cost` response metadata when present. Audio identity is a SHA-256 hash of rendered text, voice, and model, so delivery retries reuse the existing asset.

## Cloudflare R2

Create a private R2 bucket and set the R2 variables. No public bucket is required. Audio is written to deterministic keys:

```text
campaigns/{campaign_id}/contacts/{campaign_contact_id}/{audio_hash}.mp3
```

The adapter uses R2's S3 API with region `auto`, performs `PutObject`, and creates time-limited presigned `GetObject` URLs. The default URL lifetime is 86,400 seconds so a provider-held request can cross an overnight calling-hours boundary; Cloudflare's documented maximum is seven days. The bucket remains private and the URL is a bearer credential, so use the shortest operationally sufficient lifetime.

## Drop Cowboy

Set team ID, secret, registered brand ID, forwarding number, webhook secret, and (normally) the default endpoint `https://api.dropcowboy.com/v1/rvm`.

The implementation follows Drop Cowboy's current published 1-to-1 `/v1/rvm` OpenAPI contract. Authentication is sent in both the documented `x-team-id` / `x-secret` headers and the required `team_id` / `secret` body fields. The body also sends `brand_id`, E.164 `phone_number`, secure `audio_url`, `audio_type`, forwarding number, optional postal code, callback URL, and the internal Drop UUID as `foreign_id` (documented maximum 256 characters). The documented response contains only a string `status`; the app does not invent or rely on an undocumented message ID.

**Media decision:** `audio_url` is the best published transport for unique per-contact ElevenLabs files, but Drop Cowboy explicitly requires special account approval for both `audio_url` and `audio_type`. Its current public OpenAPI exposes only `GET /recording` and `GET /media`; it does not expose a recording upload endpoint. Portal-uploaded recordings must be approved and can then be referenced by `recording_id`, but that reusable-static-recording flow does not fit unique personalized audio. The provider interface isolates hosted URL from recording ID so a future approved transport can be substituted without changing campaign logic.

Drop Cowboy publishes MP3/WAV support for `audio_url`, but does not publish a maximum media size, redirect policy, hosted-URL lifetime requirement, or media retention policy. Confirm all four with the assigned account representative and prove a private R2 presigned URL fetch in the account before enabling live sends.

Configure the provider webhook URL as:

```text
https://YOUR_APP/api/webhooks/dropcowboy
```

The current RVM webhook contract reports `drop_id`, `foreign_id`, `phone_number`, `attempt_date`, `status` (`success` or `failure`), `reason`, `dnc`, cost fields, and network. The app maps success to delivered and failure to failed, preserves the entire payload, derives a stable event ID when none is supplied, and treats replay as at-least-once. The public endpoint fails closed with `503` until `DROP_COWBOY_WEBHOOK_SECRET` is configured, then requires the HMAC-SHA256 `x-dropcowboy-signature`/`x-dc-signature` header supported by the developer webhook guidance; the RVM OpenAPI itself does not define a webhook security scheme, so confirm signing behavior in the account before launch. Recognized late events remain in the delivery ledger, but the first provider final result is monotonic and cannot be regressed by a later sent/failure/delivery event; `dnc=true` always wins and produces global suppression.

Immediately before a live API call, the worker rechecks the environment switch, campaign approval and confirmed launch timestamps, configured live ceiling, selection count, normalized phone, suppression, audio ownership/readiness/type, callback and forwarding numbers, prior submission marker, and a fresh/cached `GET /brand` result proving that the exact brand is registered and API-enabled. It writes a durable submission marker before network I/O; an ambiguous timeout is not automatically retried, preventing a duplicate successful send at the cost of requiring operator review.

## Stonegate callback integration

Use `Authorization: Bearer $STONEGATE_INTEGRATION_API_KEY` (or `x-api-key`) on both endpoints.

### Lookup

```http
GET /api/integrations/callback-lookup?phone=%2B17705551234
```

The API searches recent delivered drops (default 30 days). One distinct property returns `matched`; several properties return `ambiguous` with newest candidates; no recent delivery returns `not_found`.

### Report an outcome

```http
POST /api/integrations/callback-result
Content-Type: application/json

{
  "idempotency_key": "stonegate-call-unique-id",
  "phone": "+17705551234",
  "outcome": "qualified_lead",
  "campaign_contact_id": "uuid-if-known",
  "stonegate_os_lead_id": "lead-123",
  "callback_summary": "Owner wants an offer next week",
  "callback_timestamp": "2026-09-10T18:00:00Z",
  "contract_amount_cents": 1500000,
  "revenue_cents": 2200000,
  "attribution_channel": "rvm_callback"
}
```

Supported outcomes: `callback`, `interested`, `qualified_lead`, `not_interested`, `wrong_number`, `opt_out`, `follow_up`, `contract`, and `closed`. Attribution channels are `rvm_callback` (default), `sms`, `cold_call`, and `other`. Reusing an idempotency key is a no-op and returns `duplicate: true`. A supplied campaign-contact ID must match the normalized phone and campaign. Without one, a single recent delivered property is attributed automatically. An ambiguous callback outcome is now stored without guessing a property and safely exits every open sequence for that normalized phone; callers should still supply campaign-contact ID to credit a specific campaign/lead. Unknown phones are stored without campaign attribution. Opt-out and wrong-number outcomes immediately update global suppression.

## Metrics and settings

Provider assumptions are editable in Settings. Each provider billing period stores a pricing snapshot so later edits do not rewrite prior periods. Dashboard and campaign detail views keep RVM callbacks, SMS replies, and cold-call outcomes separate and include attempted/successful RVMs, success rate, first-touch lead attribution, contracts, revenue, spend, cost-per-result, expected deals, and VA-equivalent metrics.

The current account-specific Drop Cowboy BYOC assumption is a **$250 monthly minimum/credit**, with successful RVMs consuming that credit at **$0.01 each**, failed attempts costing $0, and no Drop Cowboy compliance fee. The monthly calculation is:

```text
max(25,000 cents, successful RVM count × 1 cent)
```

It is never `$250 + usage`. Reports show both campaign marginal usage value and allocated actual monthly Drop Cowboy cost. The invoice/minimum is allocated across all campaigns in a billing period in proportion to successful RVMs, with deterministic largest-remainder cent rounding. With no successful RVMs, the minimum remains unallocated account overhead instead of being assigned arbitrarily.

The generic carrier layer is initially seeded from the supplied Twilio BYOC estimate: $15/month SIP trunk, $1.15/month per active DID, and about $0.0066/minute blended voice usage. Fixed carrier cost is allocated by attempted live RVMs. Per-drop actual duration is used when available; otherwise the editable average-seconds-per-attempt assumption is clearly labeled estimated. Twilio Messaging is not integrated.

ElevenLabs remains character based. Each successful provider generation is written to an immutable usage ledger before R2 storage is attempted, so a storage failure cannot hide consumed characters. Analytics sum those billable generation snapshots only; dry-run tones cost $0, and an already-ready asset reused on a delivery retry increments reuse visibility without charging characters again. Optional infrastructure overhead defaults to $0.

Seeded VA defaults are $7/hour, 6 real conversations/hour, 40 conversations/lead, and 15 leads/deal. Exact arithmetic gives about $1.1667/conversation, $46.67/lead, and $700/deal; fractional precision is retained through chained calculations and rounded only at the output boundary. These defaults are stored records, not hardcoded reporting assumptions.

## Authentication and security

- Passwords are bcrypt-hashed at cost 12; plaintext is only accepted by the local/initial seed process.
- Session cookies are HTTP-only, SameSite=Lax, Secure in production, and contain a random opaque token. Only its SHA-256 hash is stored.
- Browser mutation endpoints check the authenticated session and same origin.
- Provider credentials remain server-side and structured logs redact common secret fields.
- Integration keys are compared in constant time.
- Do not enable production outreach without documented consent, approved content, applicable DNC/suppression checks, and legal review of federal/state requirements.

## Health and observability

`GET /api/health` returns `200` when the web process and database are healthy, or a non-secret `503` degraded response if PostgreSQL cannot be reached. The authenticated Settings page also runs harmless, non-secret diagnostics: PostgreSQL `SELECT 1`, pg-boss queue enumeration, ElevenLabs voice lookup, R2 bucket HEAD, and Drop Cowboy brand listing. No diagnostic generates audio or submits RVM. Structured logs include campaign, drop, queue job, and entity IDs; `JobRun`, `DeliveryEvent`, and raw provider JSON provide an audit trail.

## Render deployment

`render.yaml` provisions one web service, one background worker, and one PostgreSQL database in Virginia. Both services use the internal database connection.

1. Push this repository to the Git provider connected to Render.
2. Create a new Blueprint from `render.yaml`.
3. Supply every `sync: false` secret/value. Use a long random `SESSION_SECRET`, a separate integration key, and a bcrypt hash in `ADMIN_PASSWORD_HASH` when possible.
4. Set `APP_BASE_URL` to the final HTTPS web URL.
5. The web pre-deploy step runs `prisma migrate deploy`; the first-deploy hook seeds the initial admin/settings. The orchestration migration also inserts missing new settings because an existing Render service does not rerun its initial hook.
6. Confirm `/api/health` is healthy and start the worker.
7. Keep both live flags false, confirm the worker registered `outreach-reconcile`, then configure R2 and Drop Cowboy webhooks and run a consented dry-run/small test.

`DEFAULT_CAMPAIGN_SEND_LIMIT=2000` is the normal operating default. `MAX_LIVE_CAMPAIGN_SEND_LIMIT=10` and `MAX_LIVE_DAILY_RVM_ATTEMPTS=10` remain independent environment-only launch ceilings in the checked-in Blueprint. Raise them deliberately through the planned 5–10 → small batch → 500 → 1,000 → 2,000 ramp; the effective daily allowance is the lower of the editable operating cap and environment cap.

Render filesystems are treated as ephemeral. No generated audio is written to local disk.

## Repeatable pre-production acceptance

This sequence spends ElevenLabs usage and writes private R2 objects, but cannot submit a voicemail:

1. On both web and worker, set `AUDIO_GENERATION_LIVE_ENABLED=true` and keep `RVM_LIVE_SENDS_ENABLED=false`. Configure the ElevenLabs/R2 values, Drop Cowboy credentials for diagnostics, `PREVIEW_SAMPLE_SIZE=10`, and the final HTTPS `APP_BASE_URL`. Restart both services.
2. Sign in as the admin, open Settings, and run provider checks. Require all five checks to be healthy. This only reads the selected ElevenLabs voice, R2 bucket, and Drop Cowboy brand.
3. Create a uniquely named acceptance campaign with a send limit of 10. Import exactly ten consented/internal test rows, including one missing optional name/address field. Separately test duplicate, invalid, and suppressed rows and confirm each exclusion count before committing.
4. Generate previews. Wait for the worker to complete exactly ten assets, verify every rendered script fallback, listen to all ten real ElevenLabs MP3s through the authenticated app, and confirm their deterministic objects exist in private R2.
5. Approve only after the text, pronunciation, caller identity, callback number, and opt-out language pass review. Type the exact launch confirmation and acknowledge the limit.
6. Confirm the worker records ten `DRY_RUN` drops and no Drop Cowboy RVM request appears in its account. Confirm campaign completion, audio character costs, zero RVM delivery cost, and queue/job audit rows.
7. To exercise delivery ingestion without sending, choose a dry-run Drop UUID from the test database and POST the documented success-shaped payload to `/api/webhooks/dropcowboy` (`drop_id`, that UUID as `foreign_id`, normalized `phone_number`, ISO `attempt_date`, `status: "success"`, `dnc: false`). Include the configured HMAC header. Replay the identical payload and verify only one delivery event exists and callback lookup now matches it. The synthetic dry-run delivery must not start SMS eligibility or live usage accounting.
8. POST an outcome to `/api/integrations/callback-result`, replay the same idempotency key and require `duplicate: true`, then post an `opt_out` for a test contact and verify global suppression. Use a same-phone/two-property fixture and require lookup to return `ambiguous` until `campaign_contact_id` is supplied.
9. Verify dashboard and campaign totals, including the seeded VA outputs of $1.17/conversation, $46.67/lead, and $700/deal. Archive the campaign and retain screenshots/log IDs as the acceptance record.
10. Return `AUDIO_GENERATION_LIVE_ENABLED` to the desired operating value. Leave `RVM_LIVE_SENDS_ENABLED=false` until every production gate below is signed off.

## Disposable PostgreSQL integration tests

The real-database suite applies committed migrations, exercises Prisma constraints, callback matching/attribution/idempotency/suppression, official webhook success and DNC handling, and a pg-boss job that survives a producer restart and retries once:

```powershell
$env:TEST_DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/stonegate_vm_drops_test"
npm run test:integration
```

The runner never falls back to `DATABASE_URL`, refuses when both URLs match, and requires `test` in the database name. For an intentionally disposable database with another name, also set `ALLOW_DISPOSABLE_TEST_DATABASE=true`. It mutates and cleans only test-scoped application records plus a randomly named `pgboss_test_*` schema; point it only at an empty disposable database.

## Production launch checklist

- [ ] PostgreSQL migration and seed completed
- [ ] HTTPS app URL and 32+ character session secret configured
- [ ] Admin password hash rotated from any local development value
- [ ] Private R2 bucket and presigned URL retrieval tested
- [ ] ElevenLabs voice/model and account limits verified
- [ ] Drop Cowboy brand, forwarding number, account balance, and `audio_url` approval verified
- [ ] Webhook signature secret configured and a duplicate webhook replay tested
- [ ] Current ElevenLabs, RVM, and compliance costs entered in Settings
- [ ] Consent provenance and suppression/DNC process approved by counsel/operations
- [ ] `MAX_LIVE_CAMPAIGN_SEND_LIMIT=10` and `MAX_LIVE_DAILY_RVM_ATTEMPTS=10`; first consented campaign limit explicitly set to 5–10
- [ ] Preview text and all preview audio reviewed and explicitly approved
- [ ] Web and worker logs/health monitored
- [ ] All five Settings provider-health checks pass
- [ ] Full real-audio/R2 acceptance above passes while RVM remains disabled
- [ ] Only then set `RVM_LIVE_SENDS_ENABLED=true` on both web and worker

## Quality commands

Run `npm run format`, `npm run check`, `npm run build`, and—when `TEST_DATABASE_URL` is available—`npm run test:integration`. Tests cover phone normalization, property-aware dedupe, suppression, template fallbacks, callback ambiguity/safe exits, campaign transitions, exact 24/48-hour eligibility, restart reconciliation, duplicate/repeat exports, first-touch channel attribution, timezone/DST boundaries, Drop Cowboy minimum-credit allocation, carrier forecasts, webhook idempotency, pg-boss durability, and dry-run/live-provider safety.
