import { createServer } from "node:http";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { extname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const root = resolve(".");
const publicDir = join(root, "public");
const dataDir = resolve(process.env.DATA_DIR || join(root, "data"));
const dataFile = join(dataDir, "packages.json");
const port = Number(process.env.PORT || 3000);
const checkIntervalHours = Number(process.env.CHECK_INTERVAL_HOURS || 24);
const checkerMode = (process.env.TRACKER_MODE || "scrape").toLowerCase();
const scraperEngine = (process.env.UPS_SCRAPER_ENGINE || "browser").toLowerCase();
const browserConcurrency = Number(process.env.UPS_BROWSER_CONCURRENCY || 3);
const browserStatusTimeoutMs = Number(process.env.UPS_STATUS_TIMEOUT_MS || 12000);
const chromeExecutablePath =
  process.env.CHROME_EXECUTABLE_PATH ||
  (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "");
const scrapeUrlTemplate =
  process.env.UPS_SCRAPE_URL_TEMPLATE ||
  "https://www.ups.com/track?loc=en_US&tracknum={trackingNumber}&requester=ST/trackdetails";
const require = createRequire(import.meta.url);

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

async function loadPackages() {
  try {
    const raw = await readFile(dataFile, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function savePackages(packages) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(dataFile, JSON.stringify(packages, null, 2));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function normalizeTrackingNumbers(input) {
  return String(input || "")
    .split(/[\s,;]+/)
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
}

function publicPackage(pkg) {
  return {
    id: pkg.id,
    trackingNumber: pkg.trackingNumber,
    description: pkg.description || "",
    status: pkg.status || "pending",
    carrierStatus: cleanCarrierStatus(pkg.status, pkg.carrierStatus),
    lastCheckedAt: pkg.lastCheckedAt || null,
    arrivedAt: pkg.arrivedAt || null,
    pickedUpAt: pkg.pickedUpAt || null,
    notificationSentAt: pkg.notificationSentAt || null,
    createdAt: pkg.createdAt
  };
}

function cleanCarrierStatus(status, carrierStatus) {
  const value = String(carrierStatus || "");
  const lower = value.toLowerCase();
  if (status === "picked_up") return "Picked up";
  if (status === "arrived" || lower.includes("delivered")) return "Delivered";
  if (status === "in_transit") return "In Transit";
  return value;
}

function createPackage(trackingNumber, description) {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    trackingNumber,
    description,
    status: "pending",
    carrierStatus: "Waiting for first check",
    lastCheckedAt: null,
    arrivedAt: null,
    pickedUpAt: null,
    notificationSentAt: null,
    createdAt: now
  };
}

function upsBaseUrl() {
  return process.env.UPS_ENV === "sandbox"
    ? "https://wwwcie.ups.com"
    : "https://onlinetools.ups.com";
}

async function getUpsToken() {
  const clientId = process.env.UPS_CLIENT_ID;
  const clientSecret = process.env.UPS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("UPS credentials are not configured.");
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const response = await fetch(`${upsBaseUrl()}/security/v1/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`UPS OAuth failed: ${response.status} ${detail}`);
  }

  const payload = await response.json();
  return payload.access_token;
}

function interpretUpsTracking(payload) {
  const shipment = payload?.trackResponse?.shipment?.[0];
  const pkg = shipment?.package?.[0];
  const activity = pkg?.activity?.[0];
  const status = activity?.status || pkg?.currentStatus || shipment?.currentStatus || {};
  const description = status.description || status.statusDescription || "Status unavailable";
  const type = String(status.type || status.code || "").toUpperCase();
  const lowerDescription = description.toLowerCase();
  const isDelivered =
    type === "D" ||
    lowerDescription.includes("delivered") ||
    lowerDescription.includes("available for pickup") ||
    lowerDescription.includes("ready for pickup");

  return {
    status: isDelivered ? "arrived" : "in_transit",
    carrierStatus: description,
    raw: payload
  };
}

function decodeHtml(value) {
  return String(value || "")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function normalizePageText(html) {
  return decodeHtml(html)
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function statusSnippet(text, terms) {
  const lower = text.toLowerCase();
  const sentenceMatches = text.match(/[^.!?\n]{0,90}(Delivered|On the Way|In Transit|Out for Delivery|Label Created|We Have Your Package|Left at the Dock|Available for Pickup|Ready for Pickup|Held for Pickup)[^.!?\n]{0,140}/gi);
  if (sentenceMatches?.length) {
    return sentenceMatches
      .map((match) => match.replace(/\s+/g, " ").trim())
      .find((match) => terms.some((term) => match.toLowerCase().includes(term))) || sentenceMatches[0].trim();
  }

  for (const term of terms) {
    const index = lower.indexOf(term);
    if (index !== -1) {
      const start = Math.max(0, index - 20);
      const end = Math.min(text.length, index + 90);
      return text.slice(start, end).trim();
    }
  }
  return text.slice(0, 220).trim();
}

function interpretScrapedTracking(html) {
  const text = normalizePageText(html);
  const lower = text.toLowerCase();
  const deliveredTerms = [
    "delivered",
    "available for pickup",
    "ready for pickup",
    "held for pickup",
    "pickup ready",
    "delivered to ups access point",
    "delivered to ups store"
  ];
  const transitTerms = [
    "on the way",
    "in transit",
    "out for delivery",
    "label created",
    "shipment ready for ups",
    "we have your package",
    "processing at ups facility",
    "arriving",
    "estimated delivery"
  ];
  const notFoundTerms = [
    "we could not locate the shipment details",
    "tracking number is not valid",
    "cannot be found",
    "unable to retrieve tracking information",
    "try again later"
  ];

  if (deliveredTerms.some((term) => lower.includes(term))) {
    return {
      status: "arrived",
      carrierStatus: "Delivered"
    };
  }

  if (transitTerms.some((term) => lower.includes(term))) {
    return {
      status: "in_transit",
      carrierStatus: "In Transit"
    };
  }

  if (notFoundTerms.some((term) => lower.includes(term))) {
    throw new Error(statusSnippet(text, notFoundTerms));
  }

  throw new Error("Could not read a UPS status from the tracking page. UPS may have changed the page or blocked the request.");
}

function loadPlaywright() {
  try {
    return require("playwright");
  } catch {
    return require("/Users/ben/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
  }
}

function browserLaunchOptions() {
  const launchOptions = {
    headless: true,
    args: ["--disable-http2", "--disable-blink-features=AutomationControlled"]
  };
  if (chromeExecutablePath) launchOptions.executablePath = chromeExecutablePath;
  return launchOptions;
}

async function readRenderedTrackingStatus(page, trackingNumber) {
  const url = scrapeUrlTemplate.replace("{trackingNumber}", encodeURIComponent(trackingNumber));
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < browserStatusTimeoutMs) {
    const text = await page.locator("body").innerText({ timeout: 5000 });
    try {
      return interpretScrapedTracking(text);
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(750);
    }
  }

  throw lastError || new Error("Could not read a UPS status from the tracking page.");
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let index = 0;

  async function runNext() {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
  return results;
}

async function checkUpsTrackingNumber(trackingNumber, token) {
  const url = new URL(`${upsBaseUrl()}/api/track/v1/details/${encodeURIComponent(trackingNumber)}`);
  url.searchParams.set("locale", "en_US");
  url.searchParams.set("returnSignature", "false");

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      transId: randomUUID(),
      transactionSrc: "package-pickup-tracker"
    }
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`UPS tracking failed for ${trackingNumber}: ${response.status} ${detail}`);
  }

  return interpretUpsTracking(await response.json());
}

async function scrapeUpsTrackingNumber(trackingNumber) {
  if (scraperEngine === "browser") {
    return scrapeUpsTrackingNumberWithBrowser(trackingNumber);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  const url = scrapeUrlTemplate.replace("{trackingNumber}", encodeURIComponent(trackingNumber));

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
      }
    });

    if (!response.ok) {
      throw new Error(`UPS tracking page returned ${response.status}.`);
    }

    return interpretScrapedTracking(await response.text());
  } finally {
    clearTimeout(timeout);
  }
}

async function scrapeUpsTrackingNumberWithBrowser(trackingNumber) {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch(browserLaunchOptions());

  try {
    const page = await browser.newPage({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    });
    return readRenderedTrackingStatus(page, trackingNumber);
  } finally {
    await browser.close();
  }
}

async function checkTrackingNumbersWithSharedBrowser(trackingNumbers) {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch(browserLaunchOptions());

  try {
    const checked = await mapWithConcurrency(trackingNumbers, browserConcurrency, async (trackingNumber) => {
      const page = await browser.newPage({
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
      });
      try {
        return { trackingNumber, result: await readRenderedTrackingStatus(page, trackingNumber) };
      } catch (error) {
        return { trackingNumber, error };
      } finally {
        await page.close().catch(() => {});
      }
    });

    return new Map(checked.map((item) => [item.trackingNumber, item]));
  } finally {
    await browser.close();
  }
}

async function checkTrackingNumber(trackingNumber, token) {
  if (trackingNumber.startsWith("TESTDELIVERED")) {
    return { status: "arrived", carrierStatus: "Delivered to UPS Store" };
  }
  if (trackingNumber.startsWith("TESTTRANSIT")) {
    return { status: "in_transit", carrierStatus: "In transit" };
  }

  if (checkerMode === "scrape") {
    return scrapeUpsTrackingNumber(trackingNumber);
  }

  if (!token) {
    throw new Error("UPS credentials are not configured. Add UPS_CLIENT_ID and UPS_CLIENT_SECRET to enable live checks.");
  }
  return checkUpsTrackingNumber(trackingNumber, token);
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function packageRowsHtml(packages) {
  return packages
    .map((pkg) => {
      const note = pkg.description
        ? `<div style="color:#647067;font-size:13px;line-height:18px;margin-top:4px;">${escapeHtml(pkg.description)}</div>`
        : "";
      return `
        <tr>
          <td style="padding:16px 0;border-bottom:1px solid #e2e8df;">
            <div style="font-size:16px;line-height:22px;font-weight:800;color:#17211b;letter-spacing:0;">${escapeHtml(pkg.trackingNumber)}</div>
            ${note}
          </td>
          <td align="right" style="padding:16px 0;border-bottom:1px solid #e2e8df;">
            <span style="display:inline-block;background:#dcfce7;color:#15803d;border-radius:999px;padding:6px 10px;font-size:13px;line-height:16px;font-weight:800;">Ready</span>
          </td>
        </tr>
      `;
    })
    .join("");
}

function buildPickupEmailHtml(packages) {
  const packageCount = packages.length;
  const plural = packageCount === 1 ? "package is" : "packages are";

  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f5f7f3;font-family:Arial,Helvetica,sans-serif;color:#17211b;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f7f3;padding:28px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#ffffff;border:1px solid #dfe6dc;border-radius:10px;overflow:hidden;">
            <tr>
              <td style="background:#0f766e;padding:24px 28px;">
                <div style="color:#d7f8ee;font-size:13px;line-height:18px;font-weight:800;text-transform:uppercase;">Package Pickup Tracker</div>
                <div style="color:#ffffff;font-size:28px;line-height:34px;font-weight:900;margin-top:8px;">${packageCount} ${plural} ready for pickup</div>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 28px 8px;">
                <p style="margin:0;color:#334139;font-size:16px;line-height:24px;">The following shipment${packageCount === 1 ? "" : "s"} just changed to delivered/ready status. Please pick ${packageCount === 1 ? "it" : "them"} up and mark ${packageCount === 1 ? "it" : "them"} picked up in the tracker.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 28px 8px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                  ${packageRowsHtml(packages)}
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 28px 28px;">
                <div style="background:#f0fdfa;border:1px solid #99f6e4;border-radius:8px;padding:14px 16px;color:#134e4a;font-size:14px;line-height:21px;">
                  After pickup, mark each package as picked up so future checks ignore it.
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

async function sendResendEmail(packages) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.NOTIFY_EMAIL_TO;
  const from = process.env.NOTIFY_EMAIL_FROM;
  if (!apiKey || !to || !from) return { skipped: "email not configured" };

  const lines = packages.map((pkg) => `${pkg.trackingNumber}${pkg.description ? ` - ${pkg.description}` : ""}`);
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from,
      to: to.split(",").map((item) => item.trim()).filter(Boolean),
      subject: `${packages.length} package${packages.length === 1 ? "" : "s"} ready for pickup`,
      text: `The following packages are marked arrived and need pickup:\n\n${lines.join("\n")}\n\nAfter pickup, mark each package as picked up in the tracker.`,
      html: buildPickupEmailHtml(packages)
    })
  });

  if (!response.ok) {
    throw new Error(`Email notification failed: ${response.status} ${await response.text()}`);
  }
  return { sent: "email" };
}

async function sendTwilioSms(packages) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM;
  const to = process.env.TWILIO_TO;
  if (!sid || !token || !from || !to) return { skipped: "sms not configured" };

  const body = `${packages.length} package${packages.length === 1 ? "" : "s"} ready for pickup: ${packages
    .map((pkg) => pkg.trackingNumber)
    .join(", ")}`;
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({ From: from, To: to, Body: body.slice(0, 1500) })
  });

  if (!response.ok) {
    throw new Error(`SMS notification failed: ${response.status} ${await response.text()}`);
  }
  return { sent: "sms" };
}

async function notifyArrivals(packages) {
  if (!packages.length) return [];
  const results = [];
  for (const sender of [sendResendEmail, sendTwilioSms]) {
    try {
      results.push(await sender(packages));
    } catch (error) {
      results.push({ error: error.message });
    }
  }
  console.log("Pickup notification:", packages.map((pkg) => pkg.trackingNumber).join(", "), results);
  return results;
}

async function refreshPackages() {
  const packages = await loadPackages();
  const token =
    checkerMode === "api" && process.env.UPS_CLIENT_ID && process.env.UPS_CLIENT_SECRET ? await getUpsToken() : null;
  const now = new Date().toISOString();
  const newlyArrived = [];
  const errors = [];
  const activePackages = packages.filter((pkg) => !pkg.pickedUpAt);
  const browserBatchResults =
    checkerMode === "scrape" && scraperEngine === "browser"
      ? await checkTrackingNumbersWithSharedBrowser(
          activePackages
            .map((pkg) => pkg.trackingNumber)
            .filter((trackingNumber) => !trackingNumber.startsWith("TESTDELIVERED") && !trackingNumber.startsWith("TESTTRANSIT"))
        )
      : null;

  for (const pkg of activePackages) {
    try {
      const browserBatchResult = browserBatchResults?.get(pkg.trackingNumber);
      if (browserBatchResult?.error) throw browserBatchResult.error;
      const result = browserBatchResult?.result || (await checkTrackingNumber(pkg.trackingNumber, token));
      const wasNewArrival = result.status === "arrived" && !pkg.arrivedAt;
      pkg.status = result.status;
      pkg.carrierStatus = result.carrierStatus;
      pkg.lastCheckedAt = now;

      if (result.status === "arrived" && !pkg.arrivedAt) {
        pkg.arrivedAt = now;
      }

      if (wasNewArrival) {
        newlyArrived.push(pkg);
      }
    } catch (error) {
      pkg.status = "check_failed";
      pkg.carrierStatus = error.message;
      pkg.lastCheckedAt = now;
      errors.push({ trackingNumber: pkg.trackingNumber, message: error.message });
    }
  }

  const readyForPickup = packages.filter((pkg) => pkg.status === "arrived" && !pkg.pickedUpAt);
  const notificationResults = await notifyArrivals(readyForPickup);
  if (notificationResults.some((result) => result.sent)) {
    for (const pkg of readyForPickup) {
      pkg.notificationSentAt = now;
    }
  }

  await savePackages(packages);
  return {
    checkedAt: now,
    newlyArrived: newlyArrived.map(publicPackage),
    notifiedReadyForPickup: readyForPickup.map(publicPackage),
    errors,
    notifications: notificationResults,
    packages: packages.map(publicPackage)
  };
}

async function notifyReadyForPickup() {
  const packages = await loadPackages();
  const now = new Date().toISOString();
  const readyForPickup = packages.filter((pkg) => pkg.status === "arrived" && !pkg.pickedUpAt);
  const notificationResults = await notifyArrivals(readyForPickup);

  if (notificationResults.some((result) => result.sent)) {
    for (const pkg of readyForPickup) {
      pkg.notificationSentAt = now;
    }
    await savePackages(packages);
  }

  return {
    notifiedReadyForPickup: readyForPickup.map(publicPackage),
    notifications: notificationResults,
    packages: packages.map(publicPackage)
  };
}

async function handleApi(req, res, pathname) {
  if (req.method === "GET" && pathname === "/api/packages") {
    const packages = await loadPackages();
    sendJson(res, 200, { packages: packages.map(publicPackage) });
    return;
  }

  if (req.method === "POST" && pathname === "/api/packages") {
    const body = await readJson(req);
    const numbers = normalizeTrackingNumbers(body.trackingNumbers);
    if (!numbers.length) {
      sendJson(res, 400, { error: "Enter at least one tracking number." });
      return;
    }

    const packages = await loadPackages();
    const existing = new Set(packages.map((pkg) => pkg.trackingNumber));
    const added = numbers
      .filter((number) => !existing.has(number))
      .map((number) => createPackage(number, String(body.description || "").trim()));

    await savePackages([...packages, ...added]);
    sendJson(res, 201, { added: added.map(publicPackage), skippedDuplicates: numbers.length - added.length });
    return;
  }

  if (req.method === "POST" && pathname === "/api/refresh") {
    sendJson(res, 200, await refreshPackages());
    return;
  }

  if (req.method === "POST" && pathname === "/api/notify") {
    sendJson(res, 200, await notifyReadyForPickup());
    return;
  }

  const packageMatch = pathname.match(/^\/api\/packages\/([^/]+)$/);
  if (req.method === "PATCH" && packageMatch) {
    const body = await readJson(req);
    const packages = await loadPackages();
    const pkg = packages.find((item) => item.id === packageMatch[1]);
    if (!pkg) {
      sendJson(res, 404, { error: "Package not found." });
      return;
    }
    pkg.description = String(body.description || "").trim();
    await savePackages(packages);
    sendJson(res, 200, { package: publicPackage(pkg) });
    return;
  }

  if (req.method === "DELETE" && packageMatch) {
    const packages = await loadPackages();
    const nextPackages = packages.filter((item) => item.id !== packageMatch[1]);
    if (nextPackages.length === packages.length) {
      sendJson(res, 404, { error: "Package not found." });
      return;
    }
    await savePackages(nextPackages);
    sendJson(res, 200, { deleted: true });
    return;
  }

  const pickupMatch = pathname.match(/^\/api\/packages\/([^/]+)\/pickup$/);
  if (req.method === "POST" && pickupMatch) {
    const packages = await loadPackages();
    const pkg = packages.find((item) => item.id === pickupMatch[1]);
    if (!pkg) {
      sendJson(res, 404, { error: "Package not found." });
      return;
    }
    pkg.pickedUpAt = new Date().toISOString();
    pkg.status = "picked_up";
    await savePackages(packages);
    sendJson(res, 200, { package: publicPackage(pkg) });
    return;
  }

  const unpickupMatch = pathname.match(/^\/api\/packages\/([^/]+)\/unpickup$/);
  if (req.method === "POST" && unpickupMatch) {
    const packages = await loadPackages();
    const pkg = packages.find((item) => item.id === unpickupMatch[1]);
    if (!pkg) {
      sendJson(res, 404, { error: "Package not found." });
      return;
    }
    pkg.pickedUpAt = null;
    pkg.status = pkg.arrivedAt ? "arrived" : "pending";
    await savePackages(packages);
    sendJson(res, 200, { package: publicPackage(pkg) });
    return;
  }

  sendJson(res, 404, { error: "Not found." });
}

async function serveStatic(res, pathname) {
  const filePath = pathname === "/" ? join(publicDir, "index.html") : join(publicDir, pathname);
  const resolved = resolve(filePath);
  if (!resolved.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const info = await stat(resolved);
    if (!info.isFile()) throw new Error("Not a file");
  } catch {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  res.writeHead(200, { "Content-Type": contentTypes[extname(resolved)] || "application/octet-stream" });
  createReadStream(resolved).pipe(res);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url.pathname);
    } else {
      await serveStatic(res, url.pathname);
    }
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(port, () => {
  console.log(`Package pickup tracker running at http://localhost:${port}`);
  if (checkIntervalHours > 0) {
    const intervalMs = checkIntervalHours * 60 * 60 * 1000;
    setInterval(() => {
      refreshPackages().catch((error) => console.error("Scheduled refresh failed:", error));
    }, intervalMs);
  }
});
