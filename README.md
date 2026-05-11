# Package Pickup Tracker

A small web app for tracking incoming packages through Shippo, checking whether they are ready for pickup, and marking them received.

## Run

```bash
node server.js
```

Open `http://localhost:3000`.

## Tracking

Tracking checks use Shippo only. Set a live Shippo API key for real carrier tracking:

```bash
SHIPPO_API_TOKEN=your_shippo_token
SHIPPO_CARRIER=ups
SHIPPO_TIMEOUT_MS=20000
```

Each package can be saved with Auto carrier, UPS, FedEx, or USPS. Auto carrier detects common UPS, USPS, and FedEx tracking number formats, then falls back to `SHIPPO_CARRIER` when the format is ambiguous. Shippo test keys work with Shippo mock tracking numbers such as `SHIPPO_DELIVERED` and `SHIPPO_TRANSIT`.

The app stores carrier ETA when Shippo provides it, preserves carrier status details, and detects out-for-delivery from Shippo substatus, carrier detail text, and the latest tracking history event.

## Test Numbers

These fake prefixes let you test the workflow without calling Shippo:

- `TESTDELIVERED123` becomes ready for pickup.
- `TESTOUTFORDELIVERY123` becomes out for delivery.
- `TESTTRANSIT123` stays in transit.

## Notifications

Email uses Resend and SMS uses Twilio. Leave those environment variables blank to disable notifications.

Email:

```bash
RESEND_API_KEY=your_resend_key
NOTIFY_EMAIL_FROM=Package Tracker <packages@bmcpackages.com>
NOTIFY_EMAIL_TO=bmcbreaks@gmail.com
```

Text messages:

```bash
SMS_ENABLED=false
TWILIO_ACCOUNT_SID=your_twilio_account_sid
TWILIO_AUTH_TOKEN=your_twilio_auth_token
TWILIO_FROM=+15551234567
TWILIO_TO=+15559876543
ADMIN_PASSWORD=choose_a_private_admin_password
```

Keep `SMS_ENABLED=false` while Twilio A2P approval is pending so the app does not attempt billable SMS sends. Set it to `true` after the campaign is approved. `TWILIO_FROM` must be a Twilio phone number or approved sender. `TWILIO_TO` is optional after the first deploy: the dashboard has a password-protected Text recipients dialog where phone numbers can be added or removed without changing Render environment variables. If no dashboard list has been saved yet, the app falls back to `TWILIO_TO`.

Email recipients can also be added or removed from the password-protected Recipients dialog. If no dashboard email list has been saved yet, the app falls back to `NOTIFY_EMAIL_TO`.

The dashboard has separate manual actions for status refresh, email alerts, and text alerts. `POST /api/refresh` only updates tracking statuses. `POST /api/notify/email` sends email only. `POST /api/notify/sms` sends text only, and skips Twilio unless `SMS_ENABLED=true`.

## Inbound UPS Store Emails

The app can accept inbound package-ready emails from Resend and mark matching tracking numbers as ready. This is useful for UPS Store pickup emails that arrive before Shippo updates.

Set a private webhook token:

```bash
INBOUND_EMAIL_SECRET=choose_a_private_webhook_token
```

Configure Resend Receiving to send `email.received` webhooks to:

```bash
https://bmcpackages.com/api/inbound/ups-store?token=your_private_webhook_token
```

When Resend receives a webhook, the app fetches the email body from Resend, extracts UPS, USPS, and FedEx-style tracking numbers, and marks any matching active packages as ready. Unknown tracking numbers are returned in the webhook response but are not added automatically.

## Deploy on Render

This app can run as one Render Web Service using Docker.

1. Push this project to a GitHub repository.
2. In Render, create a **New Web Service** from that repository.
3. Choose **Docker** as the runtime.
4. Add a persistent disk:
   - Mount path: `/var/data`
   - Size: 1 GB is plenty to start
5. Set environment variables:

```bash
DATA_DIR=/var/data
SHIPPO_API_TOKEN=your_shippo_token
SHIPPO_CARRIER=ups
SHIPPO_TIMEOUT_MS=20000
CHECK_INTERVAL_HOURS=0
RESEND_API_KEY=your_resend_key
NOTIFY_EMAIL_FROM=Package Tracker <packages@bmcpackages.com>
NOTIFY_EMAIL_TO=bmcbreaks@gmail.com
INBOUND_EMAIL_SECRET=choose_a_private_webhook_token
TWILIO_ACCOUNT_SID=your_twilio_account_sid
TWILIO_AUTH_TOKEN=your_twilio_auth_token
SMS_ENABLED=false
TWILIO_FROM=+15551234567
TWILIO_TO=+15559876543
ADMIN_PASSWORD=choose_a_private_admin_password
```

`CHECK_INTERVAL_HOURS=0` disables the in-process timer. For production, use Render Cron so checks happen at a predictable time even if the web service restarts.

6. Deploy the web service.
7. Add a Render Cron Job that runs daily at your chosen time and calls:

```bash
curl -X POST https://your-render-app.onrender.com/api/automation
```

The dashboard remains available at the Render web service URL. The cron endpoint refreshes tracking first, then sends enabled notifications. With `SMS_ENABLED=false`, it refreshes and sends email only.
