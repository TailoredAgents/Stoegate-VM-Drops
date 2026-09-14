# Provider contract audit

Audited against current official documentation on 2026-09-10. This file records the production assumptions implemented by the adapters; re-audit before changing a provider or enabling live RVM.

## Drop Cowboy

Sources: [current OpenAPI](https://openapi.gitbook.com/o/YMHSxyoqvIdTRVRI2PAH/spec/drop-cowboy-api.yaml), [RVM API docs](https://drop-cowboy.gitbook.io/drop-cowboy-docs/api/sending-rvm-ringless-voicemail), [RVM webhooks](https://drop-cowboy.gitbook.io/drop-cowboy-docs/api/sending-rvm-ringless-voicemail/webhooks), and [sending limits](https://drop-cowboy.gitbook.io/drop-cowboy-docs/api/sending-limits).

`POST /v1/rvm` requires `team_id`, `secret`, `foreign_id`, `brand_id`, and `phone_number`. `foreign_id` is limited to 256 characters and `phone_number` is E.164. The API security scheme also requires `x-team-id` and `x-secret`, so the adapter supplies both headers and body credentials.

The mutually exclusive media choices are:

- `recording_id`: a portal recording approved for API use.
- `voice_id` plus `tts_body`: Drop Cowboy Mimic TTS.
- `audio_url` plus `audio_type` (`mp3` or `wav`): externally hosted audio; both fields require special approval.

Other published optional fields are `forwarding_number` (E.164), `phone_ivr_id`, `pool_id`, `postal_code`, `callback_url`, and wholesale-only `byoc`. Stonegate sends forwarding number, postal code when known, and an HTTPS per-request callback URL. It does not use Mimic, IVR, or pools. The current adapter does not yet send the optional `byoc` request field; confirm the exact account/API requirement with Drop Cowboy before live activation even though economics now reflect the supplied BYOC account quote.

The documented success response is only `{ "status": "string" }`; no provider message ID is assumed. The adapter preserves loose extra fields for audit but does not use them for identity.

The public OpenAPI exposes `GET /recording` and `GET /media`, not a programmatic upload operation. Portal recordings expose `media_id`, name, creation time, and `api_allowed`. Consequently, there is no published upload-to-reusable-`recording_id` flow for per-contact ElevenLabs audio. Approved `audio_url` is the only published transport that preserves unique personalization; the typed RVM media union keeps a future transport swap isolated.

The webhook's documented fields are `drop_id`, `phone_number`, `attempt_date`, `status` (`success`/`failure`), `reason`, `dnc`, `product_cost`, `compliance_fee`, `tts_fee`, `network`, and the echoed `foreign_id`. The endpoint is unavailable until its signing secret is configured. The app maps success to delivered, failure to failed, and any `dnc=true` to opted-out/provider-DNC suppression. Raw costs are preserved because their unit/precision is not specified clearly enough to replace configured billing assumptions automatically. A first successful delivery records one successful-usage ledger entry; lower-priority or conflicting late events remain audited without regressing that final projection, while DNC always takes precedence.

### Account-specific BYOC economics

The following terms were supplied by Stonegate from its current account quote on 2026-09-14. They are business/account assumptions rather than claims about public list pricing and remain editable in Settings:

- $250 monthly minimum/credit bucket.
- $0.01 per successful RVM consumes that credit.
- Failed attempts do not incur the success charge.
- No Drop Cowboy compliance fee applies to this BYOC quote.
- Successful usage above 25,000 messages continues at $0.01/success.

Accordingly, a complete billing period is modeled as `max(25,000 cents, successful RVM count × 1 cent)`. The code never adds the $250 to usage. Campaign reporting shows marginal successful-message usage separately from its allocated share of the period invoice. Allocation is proportional to campaign successes with deterministic largest-remainder cent rounding; a period with zero successes leaves the account minimum unallocated.

### Generic SIP carrier assumption

The carrier forecast is deliberately provider-generic, although its initial editable values come from the Twilio estimate supplied with the Drop Cowboy quote:

- $15/month SIP trunk.
- $1.15/month per active DID.
- Approximately $0.0066/minute blended voice rate.

The app records actual per-drop carrier seconds when they become available and otherwise uses an editable average-seconds-per-attempt forecast. Reports label estimated/mixed duration. This is SIP-carrier economics only; there is no Twilio Messaging integration or production SMS-send code.

Not published for hosted media: maximum bytes/duration, HTTP redirect behavior, minimum URL validity window, media fetch retry policy, or retention after fetch. These are launch-blocking account questions. Cloudflare allows a presigned URL to live at most seven days; Stonegate defaults to 24 hours. Drop Cowboy states most drops complete within roughly five minutes but may hold requests outside local 8 a.m.–9 p.m. calling hours, which is why the former six-hour default was rejected.

Operational limits documented by Drop Cowboy are a soft 10,000 requests/second and fewer than 100 concurrent requests, with advance notice above 1,000 requests/second. Stonegate's default worker concurrency is four and the initial live campaign ceiling is ten—far below those transport limits. Consent, DNC, calling-hour, registration, and jurisdiction-specific compliance remain operational/legal prerequisites.

## ElevenLabs

Sources: [text-to-speech endpoint](https://elevenlabs.io/docs/api-reference/text-to-speech/convert) and [voice lookup](https://elevenlabs.io/docs/api-reference/voices/get).

Generation uses `POST /v1/text-to-speech/{voice_id}` with `xi-api-key`, JSON `text` (required), `model_id`, and optional `voice_settings`. The output query is explicit and defaults to `mp3_44100_128`; the response body is audio. The adapter records `request-id` as the generation reference and `character-cost` when returned, falling back to input text length. Provider health performs only `GET /v1/voices/{voice_id}` and returns the non-secret voice name.

## Cloudflare R2

Sources: [S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/) and [presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/).

The endpoint is `https://ACCOUNT_ID.r2.cloudflarestorage.com`, region is `auto`, writes use `PutObject`, diagnostics use `HeadBucket`, and playback/provider fetches use presigned `GetObject`. R2 documents presigned GET/HEAD/PUT/DELETE and an expiration range up to seven days. Buckets stay private; presigned URLs must be treated as temporary bearer credentials.

## Render

Sources: [Blueprint specification](https://render.com/docs/blueprint-spec) and [Render CLI](https://render.com/docs/cli).

The Blueprint defines one Node web service, one Node worker, and one same-region PostgreSQL database. Both services use the database's internal `connectionString`; the web runs `prisma migrate deploy` in `preDeployCommand`, seeds only through `initialDeployHook`, exposes `/api/health`, and both processes have graceful shutdown windows. Every credential is `sync: false` or generated. Both live switches remain `false` in source control. pg-boss stores RVM work and the recurring outreach reconciliation schedule in PostgreSQL, so jobs and eligibility timestamps survive process replacement. The checked-in campaign and daily live ceilings remain 10 while the editable operating default is 2,000; these must be raised deliberately during ramp-up.
