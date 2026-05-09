# Package Pickup Tracker

A small local web app for tracking incoming UPS packages, checking whether they are ready for pickup, and marking them picked up.

## Run

```bash
node server.js
```

Open `http://localhost:3000`.

## Tracking Modes

The default mode is public UPS page scraping, so it does not require a UPS account number or API credentials:

```bash
TRACKER_MODE=scrape
UPS_SCRAPER_ENGINE=browser
```

Browser scraping uses installed Chrome so UPS can render the tracking status before the app reads it.

If UPS blocks or changes the public page, the app will mark that package as `Check failed` with the error text. You can still switch to the official UPS API later:

```bash
TRACKER_MODE=api
UPS_CLIENT_ID=your_client_id
UPS_CLIENT_SECRET=your_client_secret
UPS_ENV=production
```

## Test Numbers

These fake prefixes let you test the workflow without calling UPS:

- `TESTDELIVERED123` becomes ready for pickup.
- `TESTTRANSIT123` stays in transit.

## Notifications

Email uses Resend and SMS uses Twilio. Leave those environment variables blank to disable notifications.
