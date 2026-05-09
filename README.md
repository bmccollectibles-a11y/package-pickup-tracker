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

## Deploy on Render

This app can run as one Render Web Service. Use Docker so the hosted app has a browser available for UPS scraping.

1. Push this project to a GitHub repository.
2. In Render, create a **New Web Service** from that repository.
3. Choose **Docker** as the runtime.
4. Add a persistent disk:
   - Mount path: `/var/data`
   - Size: 1 GB is plenty to start
5. Set environment variables:

```bash
DATA_DIR=/var/data
TRACKER_MODE=scrape
UPS_SCRAPER_ENGINE=browser
CHECK_INTERVAL_HOURS=0
RESEND_API_KEY=your_resend_key
NOTIFY_EMAIL_FROM=Package Tracker <packages@bmcpackages.com>
NOTIFY_EMAIL_TO=bmcbreaks@gmail.com
```

`CHECK_INTERVAL_HOURS=0` disables the in-process timer. For production, use Render Cron so checks happen at a predictable time even if the web service restarts.

6. Deploy the web service.
7. Add a Render Cron Job that runs daily at your chosen time and calls:

```bash
curl -X POST https://your-render-app.onrender.com/api/refresh
```

The dashboard remains available at the Render web service URL, and the cron job uses the same refresh/email logic as the manual button.
