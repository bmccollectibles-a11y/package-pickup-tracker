# Package Pickup Tracker

A small web app for tracking incoming packages through Shippo, checking whether they are ready for pickup, and marking them picked up.

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

`SHIPPO_CARRIER` defaults to `ups`, but can be changed to another Shippo carrier token such as `fedex` when needed. Shippo test keys work with Shippo mock tracking numbers such as `SHIPPO_DELIVERED` and `SHIPPO_TRANSIT`.

The app stores carrier ETA when Shippo provides it and detects `out_for_delivery` substatus when available.

## Test Numbers

These fake prefixes let you test the workflow without calling Shippo:

- `TESTDELIVERED123` becomes ready for pickup.
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
TWILIO_ACCOUNT_SID=your_twilio_account_sid
TWILIO_AUTH_TOKEN=your_twilio_auth_token
TWILIO_FROM=+15551234567
TWILIO_TO=+15559876543
```

`TWILIO_FROM` must be a Twilio phone number or approved sender. `TWILIO_TO` can be one number or a comma-separated list of numbers.

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
TWILIO_ACCOUNT_SID=your_twilio_account_sid
TWILIO_AUTH_TOKEN=your_twilio_auth_token
TWILIO_FROM=+15551234567
TWILIO_TO=+15559876543
```

`CHECK_INTERVAL_HOURS=0` disables the in-process timer. For production, use Render Cron so checks happen at a predictable time even if the web service restarts.

6. Deploy the web service.
7. Add a Render Cron Job that runs daily at your chosen time and calls:

```bash
curl -X POST https://your-render-app.onrender.com/api/refresh
```

The dashboard remains available at the Render web service URL, and the cron job uses the same refresh/email logic as the manual button.
