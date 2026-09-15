# Twilio setup for Stonegate SMS Outreach

The application is prepared for Twilio Programmable Messaging, but the
checked-in configuration cannot send SMS. Complete the real business,
registration, consent, and content review in Twilio before changing either
production gate.

## Twilio Console work

1. Create or verify Stonegate's Twilio business/customer profile using the
   business's truthful legal and contact information.
2. Register the real A2P 10DLC Brand. Do not substitute a different business
   identity or use case to obtain approval.
3. Create a Messaging Service for Stonegate's approved outreach use case.
4. Obtain new 10DLC phone number(s) for that use case and add them to the
   Messaging Service Sender Pool. Stonegate does not rotate numbers itself.
5. Submit the real messaging Campaign/use case, including the actual consent
   flow, sample messages, opt-in and opt-out behavior, and expected traffic.
6. Wait for the Campaign to be approved/VERIFIED and associate it with the
   Messaging Service. An application note or a successful API login is not
   carrier approval.
7. Set the Messaging Service's inbound message webhook to:

   `${APP_BASE_URL}/api/webhooks/twilio/inbound`

   Use HTTP `POST`. Here `APP_BASE_URL` means the full HTTPS origin, such as
   `https://sms.stonegate.example`, with no trailing route.

8. Review and configure Advanced Opt-Out for the approved program. Stonegate
   also records STOP-class keywords in its own global suppression list.

Every outbound API request supplies this status callback automatically:

`${APP_BASE_URL}/api/webhooks/twilio/status`

Both routes validate `X-Twilio-Signature` with the Auth Token and return no
automatic text reply.

## Render configuration

Add the following values manually to both the existing web and worker services.
Do not paste the Auth Token into source control or the Blueprint:

```text
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=<secret>
TWILIO_MESSAGING_SERVICE_SID=MG...
TWILIO_PRODUCTION_APPROVED=false
```

The web service needs them for signature validation and read-only diagnostics;
the worker needs them for the later controlled send. Confirm that
`APP_BASE_URL` is the exact public HTTPS origin, with no route suffix.

Leave these settings unchanged during setup:

```text
SMS_PROVIDER=dry-run
SMS_LIVE_SENDS_ENABLED=false
TWILIO_PRODUCTION_APPROVED=false
MAX_LIVE_SMS_CAMPAIGN_LIMIT=10
MAX_LIVE_DAILY_SMS_LIMIT=10
```

Run the admin-only provider diagnostic. It authenticates, fetches the configured
Messaging Service, inspects its Sender Pool, checks Twilio's A2P registration
metadata, and verifies the exact inbound webhook; it never sends a message.
Use the Settings compliance/readiness notes for any human context that Twilio
does not expose. Have an active admin acknowledge production approval only after
the external approval is genuine. A diagnostic expires after 24 hours and must
still be current when the campaign launches and when each send is reserved.

## Controlled acceptance test after approval

Only after the Campaign is actually approved and the read-only diagnostic
passes:

1. Verify the inbound webhook and the application's status callback URL.
2. Run the read-only diagnostic and record the active admin acknowledgement.
3. Set `SMS_PROVIDER=twilio` on both services while keeping both live gates
   `false`, then redeploy.
4. Import a fresh controlled campaign under that configuration, select the
   approved template, and review/approve exactly 5-10 consented test recipients.
   A campaign created under `dry-run` cannot be silently promoted to Twilio.
5. Recheck consent evidence, suppressions, send window, Messaging Service SID,
   and that the diagnostic is still fresh.
6. Set `TWILIO_PRODUCTION_APPROVED=true` and
   `SMS_LIVE_SENDS_ENABLED=true` on both services only for the controlled batch,
   then redeploy.
7. Launch the approved campaign with the exact `LAUNCH <campaign name>` typed
   confirmation and limits no greater than 10.
8. Review delivery events, replies, opt-outs, actual sender assignment, Twilio
   error codes, and the bounded actual-cost reconciliation before considering
   any later increase. Turn live sending back off after the acceptance window.

Credentials, a Sender Pool, or an admin acknowledgement by themselves cannot
activate traffic. Both environment gates, current passing diagnostics, an
approved campaign/template, verified contact-level consent, and all existing
safety checks are required.
