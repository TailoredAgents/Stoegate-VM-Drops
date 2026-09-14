# SMS Provider Decision Record

## Status

No production SMS provider has been selected, audited, or configured for
Stonegate SMS Outreach.

The only supported checked-in configuration is:

```text
SMS_LIVE_SENDS_ENABLED=false
SMS_PROVIDER=dry-run
```

No production credential, API endpoint, sender identity, webhook secret,
pricing assumption, throughput claim, or activation instruction belongs in
this document until a provider is selected and its current official contract
has been reviewed.

## Existing provider-neutral boundary

The application exposes an authenticated canonical endpoint at
`POST /api/webhooks/sms`. It is disabled unless
`SMS_PROVIDER_WEBHOOK_SECRET` is configured, requires an
`x-stonegate-signature` HMAC-SHA256 signature over the exact request body, and
rejects events whose `providerKey` differs from `SMS_PROVIDER`.

A future provider adapter must map the provider's verified delivery and inbound
payloads into the canonical `delivery_status` or `inbound_message` contract.
The mapping must include stable provider event/message IDs, explicit timestamps,
and the original JSON object in `rawPayload`. This endpoint does not imply that
any provider's native signature scheme has been reviewed or implemented.

## Required provider contract

A candidate must support or have a documented operating answer for all of the
following before implementation:

- authenticated outbound SMS requests;
- an idempotency mechanism or a safe application-side strategy for ambiguous
  timeouts;
- stable provider message identifiers;
- documented queued, sent, delivered, failed, rejected, and unknown statuses;
- authenticated delivery-event webhooks with replay guidance;
- authenticated inbound message and opt-out events;
- E.164 destination handling and clear invalid-number errors;
- a known, normalized originating number that can be persisted before dispatch,
  so inbound replies can be matched to the exact outbound message;
- sender registration and account activation requirements;
- account-specific throughput, queue, rate-limit, and retry behavior;
- event timestamp format, precision, and out-of-order behavior;
- sandbox, test-number, or other non-production validation support;
- exportable usage and pricing data suitable for reconciliation;
- documented data retention, redaction, and deletion controls.

Unknown or account-specific behavior must be recorded as an open question, not
filled in from memory or another provider's conventions.

## Evaluation process

1. Shortlist providers based on Stonegate's sending regions, expected volume,
   sender type, inbound-reply needs, and operational support requirements.
2. Review then-current official API, webhook, security, registration, and rate
   documentation.
3. Record the exact account/product tier being evaluated; do not assume public
   list pricing or limits apply to Stonegate's account.
4. Obtain a test account and prove outbound idempotency, delivery events,
   inbound replies, opt-outs, invalid numbers, throttling, and ambiguous
   timeouts.
5. Confirm how provider timestamps and duplicate events map to the application's
   append-only event ledger.
6. Complete security, privacy, operational, and independent legal review.
7. Document the decision, rejected alternatives, unresolved risks, and rollback
   path before adding an adapter or secret variables.

## Minimum acceptance tests

- A dry-run campaign cannot make a provider network request.
- The live switch alone cannot activate the `dry-run` adapter.
- Replaying the same provider event changes state at most once.
- Reusing a provider ID for conflicting contacts or outcomes is rejected.
- An ambiguous request timeout cannot trigger an automatic duplicate send.
- A reply stops later outreach for the intended contact.
- A STOP, manual suppression, or campaign pause that wins the dispatch lock
  prevents the provider call; if dispatch wins, its provider result is persisted
  before the control action proceeds.
- Opt-out, DNC, and wrong-number outcomes suppress the normalized phone across
  campaigns.
- A repeated `sent` event cannot restart the cold-call delay.
- Invalid signatures fail closed without logging secrets.
- A provider outage remains bounded by queue concurrency and retry policy.

## Live activation gate

A production adapter is not complete merely because an API request succeeds.
Before `SMS_LIVE_SENDS_ENABLED` can be changed, Stonegate must verify account
activation, sender registration, webhook authentication, monitoring, alerting,
support escalation, cost controls, message review, suppression behavior,
rollback, and a deliberately limited acceptance batch.

Stonegate is responsible for obtaining its own advice about consent,
registration, quiet hours, disclosures, opt-out handling, record retention, and
other applicable obligations. Application controls and this review process do
not constitute a claim of compliance.

## Render topology

The existing Render Blueprint continues to define one web service, one worker,
and one PostgreSQL database. Their resource identifiers intentionally retain
the old names to preserve the deployed resources during the rebrand. Those
identifiers do not imply that an archived provider or channel is active.

Both services keep `SMS_PROVIDER=dry-run` and
`SMS_LIVE_SENDS_ENABLED=false`. Any future provider secret must be configured
through Render's secret environment settings and must never be committed.
