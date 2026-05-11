import { createServer } from "node:http";
import { readFile, writeFile, mkdir, stat, rename } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { extname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const root = resolve(".");
const publicDir = join(root, "public");
const dataDir = resolve(process.env.DATA_DIR || join(root, "data"));
const dataFile = join(dataDir, "packages.json");
const notificationSettingsFile = join(dataDir, "notification-settings.json");
const port = Number(process.env.PORT || 3000);
const checkIntervalHours = Number(process.env.CHECK_INTERVAL_HOURS || 24);
const shippoCarrier = (process.env.SHIPPO_CARRIER || "ups").toLowerCase();
const shippoTimeoutMs = Number(process.env.SHIPPO_TIMEOUT_MS || 20000);
const adminPassword = process.env.ADMIN_PASSWORD || "";
const smsEnabled = process.env.SMS_ENABLED === "true";

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

async function loadNotificationSettings() {
  try {
    const raw = await readFile(notificationSettingsFile, "utf8");
    const parsed = JSON.parse(raw);
    return {
      smsRecipients: Array.isArray(parsed.smsRecipients) ? normalizePhoneNumbers(parsed.smsRecipients) : null
    };
  } catch (error) {
    if (error.code === "ENOENT") return { smsRecipients: null };
    throw error;
  }
}

async function saveNotificationSettings(settings) {
  await mkdir(dataDir, { recursive: true });
  const tempFile = `${notificationSettingsFile}.${randomUUID()}.tmp`;
  await writeFile(tempFile, JSON.stringify(settings, null, 2));
  await rename(tempFile, notificationSettingsFile);
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

function readBearerToken(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

function authorizeAdmin(req, res) {
  if (!adminPassword) {
    sendJson(res, 503, { error: "Admin password is not configured." });
    return false;
  }
  if (readBearerToken(req) !== adminPassword) {
    sendJson(res, 401, { error: "Enter the admin password to manage text recipients." });
    return false;
  }
  return true;
}

function normalizeTrackingNumbers(input) {
  return String(input || "")
    .split(/[\s,;]+/)
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
}

function normalizePhoneNumber(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  const compact = trimmed.replace(/[()\s.-]/g, "");
  const withCountryCode =
    /^\d{10}$/.test(compact) ? `+1${compact}` : /^1\d{10}$/.test(compact) ? `+${compact}` : compact;
  if (!/^\+[1-9]\d{7,14}$/.test(withCountryCode)) {
    throw new Error(`Enter ${trimmed} as a valid phone number, like +14085551212.`);
  }
  return withCountryCode;
}

function normalizePhoneNumbers(input) {
  const values = Array.isArray(input) ? input : String(input || "").split(/[\s,;]+/);
  return [...new Set(values.map(normalizePhoneNumber).filter(Boolean))];
}

function normalizeCarrier(value) {
  const carrier = String(value || "").trim().toLowerCase();
  if (!carrier || carrier === "auto") return "auto";
  if (["ups", "fedex", "usps"].includes(carrier)) return carrier;
  throw new Error("Carrier must be UPS, FedEx, USPS, or Auto.");
}

function detectCarrier(trackingNumber) {
  const normalized = String(trackingNumber || "").trim().toUpperCase();
  const digitsOnly = normalized.replace(/\D/g, "");
  if (normalized.startsWith("1Z")) return "ups";
  if (/^(92|93|94|95|96)\d{18,32}$/.test(digitsOnly)) return "usps";
  if (/^\d{12}$|^\d{15}$|^\d{20}$|^\d{22}$/.test(digitsOnly)) return "fedex";
  return shippoCarrier;
}

function envSmsRecipients() {
  return normalizePhoneNumbers(process.env.TWILIO_TO || "");
}

async function smsRecipients() {
  const settings = await loadNotificationSettings();
  return settings.smsRecipients === null ? envSmsRecipients() : settings.smsRecipients;
}

function publicPackage(pkg) {
  return {
    id: pkg.id,
    trackingNumber: pkg.trackingNumber,
    description: pkg.description || "",
    seller: pkg.seller || "",
    carrier: normalizeCarrier(pkg.carrier || "auto"),
    resolvedCarrier: resolvePackageCarrier(pkg),
    status: pkg.status || "pending",
    carrierStatus: cleanCarrierStatus(pkg.status, pkg.carrierStatus),
    eta: pkg.eta || null,
    originalEta: pkg.originalEta || null,
    trackingSubstatus: pkg.trackingSubstatus || null,
    lastCheckedAt: pkg.lastCheckedAt || null,
    arrivedAt: pkg.arrivedAt || null,
    pickedUpAt: pkg.pickedUpAt || null,
    receivedBy: pkg.receivedBy || "",
    receivedNote: pkg.receivedNote || "",
    notificationSentAt: pkg.notificationSentAt || null,
    createdAt: pkg.createdAt
  };
}

function cleanCarrierStatus(status, carrierStatus) {
  const value = String(carrierStatus || "");
  const lower = value.toLowerCase();
  if (status === "picked_up") return "Received";
  if (status === "arrived" || lower.includes("delivered")) return "Delivered";
  if (status === "out_for_delivery") return "Out for Delivery";
  if (status === "in_transit") return value || "In Transit";
  return value;
}

function createPackage(trackingNumber, description, carrier) {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    trackingNumber,
    description,
    seller: "",
    carrier: normalizeCarrier(carrier),
    status: "pending",
    carrierStatus: "Waiting for first check",
    eta: null,
    originalEta: null,
    trackingSubstatus: null,
    lastCheckedAt: null,
    arrivedAt: null,
    pickedUpAt: null,
    receivedBy: "",
    receivedNote: "",
    notificationSentAt: null,
    createdAt: now
  };
}

function resolvePackageCarrier(pkg) {
  return pkg.carrier && pkg.carrier !== "auto" ? normalizeCarrier(pkg.carrier) : detectCarrier(pkg.trackingNumber);
}

function shippoCarrierForTrackingNumber(trackingNumber, carrier) {
  return trackingNumber.startsWith("SHIPPO_") ? "shippo" : carrier;
}

function substatusValue(substatus, key) {
  if (!substatus) return "";
  if (typeof substatus === "string") return key === "code" ? substatus : "";
  return substatus[key] || "";
}

function statusTextParts(event) {
  if (!event) return [];
  if (typeof event === "string") return [event];
  return [
    event.status,
    event.status_details,
    event.message,
    event.description,
    event.carrier_status,
    event.carrier_status_description,
    substatusValue(event.substatus, "code"),
    substatusValue(event.substatus, "text"),
    substatusValue(event.substatus, "description")
  ].filter(Boolean);
}

function eventDetails(event) {
  if (!event || typeof event === "string") return event || "";
  return firstValue(
    event.status_details,
    event.message,
    substatusValue(event.substatus, "text"),
    substatusValue(event.substatus, "description"),
    event.carrier_status_description,
    event.description,
    event.status,
    event.carrier_status
  );
}

function eventTime(event) {
  const time = new Date(event?.status_date || event?.object_updated || event?.object_created || 0).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function eventStatusTime(event) {
  const time = new Date(event?.status_date || 0).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function latestTrackingHistoryEvent(payload) {
  return Array.isArray(payload?.tracking_history)
    ? [...payload.tracking_history].sort((a, b) => eventTime(b) - eventTime(a))[0]
    : null;
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "") || null;
}

function shippoEta(payload) {
  return firstValue(
    payload?.eta,
    payload?.estimated_delivery_date,
    payload?.estimated_delivery,
    payload?.expected_delivery_date,
    payload?.expected_delivery,
    payload?.scheduled_delivery_date,
    payload?.scheduled_delivery,
    payload?.tracking_status?.eta,
    payload?.tracking_status?.estimated_delivery_date,
    payload?.tracking_status?.expected_delivery_date,
    payload?.tracking_status?.scheduled_delivery_date
  );
}

function shippoOriginalEta(payload) {
  return firstValue(
    payload?.original_eta,
    payload?.original_estimated_delivery_date,
    payload?.original_expected_delivery_date,
    payload?.original_scheduled_delivery_date
  );
}

function isOutForDeliveryText(value) {
  const text = String(value || "").toLowerCase();
  return (
    text.includes("out_for_delivery") ||
    text.includes("out for delivery") ||
    text.includes("on vehicle for delivery") ||
    text.includes("on fedex vehicle for delivery") ||
    text.includes("loaded on delivery vehicle") ||
    text.includes("with delivery courier") ||
    text.includes("with delivery driver")
  );
}

function interpretShippoTracking(payload) {
  const trackingStatus = payload?.tracking_status;
  const latestHistory = latestTrackingHistoryEvent(payload);
  const status =
    typeof trackingStatus === "string"
      ? trackingStatus
      : trackingStatus?.status || payload?.status || payload?.object_state || "UNKNOWN";
  const substatus =
    typeof trackingStatus === "object" && trackingStatus
      ? substatusValue(trackingStatus.substatus, "code") || substatusValue(trackingStatus.substatus, "text") || null
      : null;
  const currentParts = statusTextParts(trackingStatus);
  const latestParts =
    latestHistory && (!eventStatusTime(trackingStatus) || eventStatusTime(latestHistory) >= eventStatusTime(trackingStatus))
      ? statusTextParts(latestHistory)
      : [];
  const details = firstValue(
    eventDetails(trackingStatus),
    eventDetails(latestHistory),
    status
  );
  const normalizedStatus = String(status || "").toUpperCase();
  const latestStatus = String(latestHistory?.status || "").toUpperCase();
  const normalizedDetails = [...currentParts, ...latestParts].join(" ").toLowerCase();
  const delivered = normalizedStatus === "DELIVERED" || latestStatus === "DELIVERED" || normalizedDetails.includes("delivered");
  const outForDelivery = !delivered && [...currentParts, ...latestParts].some(isOutForDeliveryText);

  return {
    status: delivered ? "arrived" : outForDelivery ? "out_for_delivery" : "in_transit",
    carrierStatus: delivered ? "Delivered" : outForDelivery ? "Out for Delivery" : details || "In Transit",
    eta: shippoEta(payload),
    originalEta: shippoOriginalEta(payload),
    trackingSubstatus: substatus || null,
    raw: payload
  };
}

function updatePackageTrackingFields(pkg, result) {
  pkg.status = result.status;
  pkg.carrierStatus = result.carrierStatus;
  pkg.eta = result.eta || null;
  pkg.originalEta = result.originalEta || null;
  pkg.trackingSubstatus = result.trackingSubstatus || null;
}

function packagesForPickupEmail(packages) {
  return packages.filter((pkg) => (pkg.status === "arrived" || pkg.status === "out_for_delivery") && !pkg.pickedUpAt);
}

function emailStatusLabel(pkg) {
  if (pkg.status === "arrived") return "Ready";
  if (pkg.status === "out_for_delivery") return "Out for delivery";
  return cleanCarrierStatus(pkg.status, pkg.carrierStatus) || "In Transit";
}

function formatEmailEta(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Los_Angeles"
  }).format(new Date(value));
}

function attentionSummary(packages) {
  const ready = packages.filter((pkg) => pkg.status === "arrived").length;
  const outForDelivery = packages.filter((pkg) => pkg.status === "out_for_delivery").length;
  return { ready, outForDelivery };
}

async function checkShippoTrackingNumber(pkg) {
  const token = process.env.SHIPPO_API_TOKEN;
  if (!token) {
    throw new Error("Shippo API token is not configured. Add SHIPPO_API_TOKEN to enable Shippo checks.");
  }

  const trackingNumber = typeof pkg === "string" ? pkg : pkg.trackingNumber;
  const carrier = shippoCarrierForTrackingNumber(trackingNumber, typeof pkg === "string" ? shippoCarrier : resolvePackageCarrier(pkg));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), shippoTimeoutMs);
  const headers = {
    Authorization: `ShippoToken ${token}`,
    Accept: "application/json"
  };
  try {
    const response = trackingNumber.startsWith("SHIPPO_")
      ? await fetch("https://api.goshippo.com/tracks/", {
          method: "POST",
          signal: controller.signal,
          headers: {
            ...headers,
            "Content-Type": "application/x-www-form-urlencoded"
          },
          body: new URLSearchParams({
            carrier,
            tracking_number: trackingNumber,
            metadata: "Package Pickup Tracker test"
          })
        })
      : await fetch(`https://api.goshippo.com/tracks/${encodeURIComponent(carrier)}/${encodeURIComponent(trackingNumber)}`, {
          signal: controller.signal,
          headers
        });

    if (!response.ok) {
      throw new Error(`Shippo tracking failed for ${trackingNumber}: ${response.status} ${await response.text()}`);
    }

    return interpretShippoTracking(await response.json());
  } finally {
    clearTimeout(timeout);
  }
}

async function checkTrackingNumber(pkg) {
  const trackingNumber = typeof pkg === "string" ? pkg : pkg.trackingNumber;
  if (trackingNumber.startsWith("TESTDELIVERED")) {
    return { status: "arrived", carrierStatus: "Delivered", eta: null, originalEta: null, trackingSubstatus: null };
  }
  if (trackingNumber.startsWith("TESTOUTFORDELIVERY")) {
    return { status: "out_for_delivery", carrierStatus: "Out for Delivery", eta: null, originalEta: null, trackingSubstatus: "out_for_delivery" };
  }
  if (trackingNumber.startsWith("TESTTRANSIT")) {
    return { status: "in_transit", carrierStatus: "In transit", eta: null, originalEta: null, trackingSubstatus: null };
  }
  return checkShippoTrackingNumber(pkg);
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
      const eta = pkg.eta
        ? `<div style="color:#647067;font-size:13px;line-height:18px;margin-top:4px;">ETA ${escapeHtml(formatEmailEta(pkg.eta))}</div>`
        : "";
      const isOutForDelivery = pkg.status === "out_for_delivery";
      const badgeBg = isOutForDelivery ? "#e0f2fe" : "#dcfce7";
      const badgeColor = isOutForDelivery ? "#075985" : "#15803d";
      return `
        <tr>
          <td style="padding:16px 0;border-bottom:1px solid #e2e8df;">
            <div style="font-size:16px;line-height:22px;font-weight:800;color:#17211b;letter-spacing:0;">${escapeHtml(pkg.trackingNumber)}</div>
            ${note}
            ${eta}
          </td>
          <td align="right" style="padding:16px 0;border-bottom:1px solid #e2e8df;">
            <span style="display:inline-block;background:${badgeBg};color:${badgeColor};border-radius:999px;padding:6px 10px;font-size:13px;line-height:16px;font-weight:800;">${emailStatusLabel(pkg)}</span>
          </td>
        </tr>
      `;
    })
    .join("");
}

function buildPickupEmailHtml(packages) {
  const packageCount = packages.length;
  const plural = packageCount === 1 ? "package is" : "packages are";
  const { ready, outForDelivery } = attentionSummary(packages);

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
	                <div style="color:#ffffff;font-size:28px;line-height:34px;font-weight:900;margin-top:8px;">${packageCount} ${plural} ready or out for delivery</div>
	              </td>
	            </tr>
	            <tr>
	              <td style="padding:24px 28px 8px;">
	                <p style="margin:0;color:#334139;font-size:16px;line-height:24px;">${ready} ready for pickup. ${outForDelivery} out for delivery. Use the ETA to time the pickup trip, then mark packages received after they are collected.</p>
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
                  After pickup, mark each package as received so future checks ignore it.
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

  const { ready, outForDelivery } = attentionSummary(packages);
  const lines = packages.map((pkg) => {
    const eta = pkg.eta ? ` - ETA ${formatEmailEta(pkg.eta)}` : "";
    return `${emailStatusLabel(pkg)}: ${pkg.trackingNumber}${pkg.description ? ` - ${pkg.description}` : ""}${eta}`;
  });
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from,
      to: to.split(",").map((item) => item.trim()).filter(Boolean),
      subject: `${ready} ready, ${outForDelivery} out for delivery`,
      text: `Package pickup status:\n\n${lines.join("\n")}\n\nAfter pickup, mark each package as received in the tracker.`,
      html: buildPickupEmailHtml(packages)
    })
  });

  if (!response.ok) {
    throw new Error(`Email notification failed: ${response.status} ${await response.text()}`);
  }
  return { sent: "email" };
}

async function sendTwilioSms(packages) {
  if (!smsEnabled) return { skipped: "sms disabled" };

  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM;
  const recipients = await smsRecipients();
  if (!sid || !token || !from || !recipients.length) return { skipped: "sms not configured" };

  const { ready, outForDelivery } = attentionSummary(packages);
  const lines = packages.map((pkg) => {
    const eta = pkg.eta ? ` ETA ${formatEmailEta(pkg.eta)}` : "";
    return `${emailStatusLabel(pkg)}: ${pkg.trackingNumber}${pkg.description ? ` - ${pkg.description}` : ""}${eta}`;
  });
  const body = [`BMC packages: ${ready} ready, ${outForDelivery} out for delivery.`, ...lines].join("\n");
  const results = [];
  for (const recipient of recipients) {
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({ From: from, To: recipient, Body: body.slice(0, 1500) })
    });

    if (!response.ok) {
      throw new Error(`SMS notification failed for ${recipient}: ${response.status} ${await response.text()}`);
    }
    results.push(recipient);
  }
  return { sent: "sms", recipients: results.length };
}

async function notifyArrivals(packages, senders = [sendResendEmail, sendTwilioSms]) {
  if (!packages.length) return [];
  const results = [];
  for (const sender of senders) {
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
  const now = new Date().toISOString();
  const newlyArrived = [];
  const newlyOutForDelivery = [];
  const errors = [];
  const activePackages = packages.filter((pkg) => !pkg.pickedUpAt);

  for (const pkg of activePackages) {
    try {
      const previousStatus = pkg.status;
      const result = await checkTrackingNumber(pkg);
      const wasNewArrival = result.status === "arrived" && !pkg.arrivedAt;
      const wasNewOutForDelivery = result.status === "out_for_delivery" && previousStatus !== "out_for_delivery";
      updatePackageTrackingFields(pkg, result);
      pkg.lastCheckedAt = now;

      if (result.status === "arrived" && !pkg.arrivedAt) {
        pkg.arrivedAt = now;
      }

      if (wasNewArrival) {
        newlyArrived.push(pkg);
      }
      if (wasNewOutForDelivery) {
        newlyOutForDelivery.push(pkg);
      }
    } catch (error) {
      pkg.status = "check_failed";
      pkg.carrierStatus = error.message;
      pkg.eta = null;
      pkg.originalEta = null;
      pkg.trackingSubstatus = null;
      pkg.lastCheckedAt = now;
      errors.push({ trackingNumber: pkg.trackingNumber, message: error.message });
    }
  }

  await savePackages(packages);
  return {
    checkedAt: now,
    newlyArrived: newlyArrived.map(publicPackage),
    newlyOutForDelivery: newlyOutForDelivery.map(publicPackage),
    errors,
    packages: packages.map(publicPackage)
  };
}

async function notifyReadyForPickup(senders = [sendResendEmail, sendTwilioSms]) {
  const packages = await loadPackages();
  const now = new Date().toISOString();
  const readyForPickup = packagesForPickupEmail(packages);
  const notificationResults = await notifyArrivals(readyForPickup, senders);

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

async function runAutomation() {
  const refreshResult = await refreshPackages();
  const notifyResult = await notifyReadyForPickup();
  return {
    ...refreshResult,
    notifiedReadyForPickup: notifyResult.notifiedReadyForPickup,
    notifications: notifyResult.notifications,
    packages: notifyResult.packages
  };
}

async function handleApi(req, res, pathname) {
  if (req.method === "GET" && pathname === "/api/packages") {
    const packages = await loadPackages();
    sendJson(res, 200, { packages: packages.map(publicPackage) });
    return;
  }

  if (req.method === "GET" && pathname === "/api/config") {
    const configuredSmsRecipients = await smsRecipients();
    sendJson(res, 200, {
      trackerMode: "shippo",
      shippoCarrier,
      shippoConfigured: Boolean(process.env.SHIPPO_API_TOKEN),
      adminConfigured: Boolean(adminPassword),
      smsEnabled,
      smsConfigured: Boolean(
        smsEnabled &&
        process.env.TWILIO_ACCOUNT_SID &&
          process.env.TWILIO_AUTH_TOKEN &&
          process.env.TWILIO_FROM &&
          configuredSmsRecipients.length
      ),
      checkIntervalHours
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/notification-settings") {
    if (!authorizeAdmin(req, res)) return;
    const settings = await loadNotificationSettings();
    const recipients = settings.smsRecipients === null ? envSmsRecipients() : settings.smsRecipients;
    sendJson(res, 200, {
      smsRecipients: recipients,
      usingEnvSmsRecipients: settings.smsRecipients === null && recipients.length > 0,
      smsEnabled,
      twilioConfigured: Boolean(smsEnabled && process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM)
    });
    return;
  }

  if (req.method === "PUT" && pathname === "/api/notification-settings") {
    if (!authorizeAdmin(req, res)) return;
    const body = await readJson(req);
    let smsRecipients;
    try {
      smsRecipients = normalizePhoneNumbers(body.smsRecipients || []);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
      return;
    }
    await saveNotificationSettings({ smsRecipients });
    sendJson(res, 200, { smsRecipients });
    return;
  }

  if (req.method === "POST" && pathname === "/api/packages") {
    const body = await readJson(req);
    const numbers = normalizeTrackingNumbers(body.trackingNumbers);
    if (!numbers.length) {
      sendJson(res, 400, { error: "Enter at least one tracking number." });
      return;
    }
    let carrier;
    try {
      carrier = normalizeCarrier(body.carrier || "auto");
    } catch (error) {
      sendJson(res, 400, { error: error.message });
      return;
    }

    const packages = await loadPackages();
    const existing = new Set(packages.map((pkg) => pkg.trackingNumber));
    const added = numbers
      .filter((number) => !existing.has(number))
      .map((number) => createPackage(number, String(body.description || "").trim(), carrier));

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

  if (req.method === "POST" && pathname === "/api/notify/email") {
    sendJson(res, 200, await notifyReadyForPickup([sendResendEmail]));
    return;
  }

  if (req.method === "POST" && pathname === "/api/notify/sms") {
    sendJson(res, 200, await notifyReadyForPickup([sendTwilioSms]));
    return;
  }

  if (req.method === "POST" && pathname === "/api/automation") {
    sendJson(res, 200, await runAutomation());
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
    if (body.seller !== undefined) {
      pkg.seller = String(body.seller || "").trim();
    }
    if (body.carrier !== undefined) {
      try {
        pkg.carrier = normalizeCarrier(body.carrier);
      } catch (error) {
        sendJson(res, 400, { error: error.message });
        return;
      }
    }
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
    const body = await readJson(req);
    const packages = await loadPackages();
    const pkg = packages.find((item) => item.id === pickupMatch[1]);
    if (!pkg) {
      sendJson(res, 404, { error: "Package not found." });
      return;
    }
    pkg.pickedUpAt = new Date().toISOString();
    pkg.status = "picked_up";
    pkg.receivedBy = String(body.receivedBy || "").trim();
    pkg.receivedNote = String(body.receivedNote || "").trim();
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
    pkg.receivedBy = "";
    pkg.receivedNote = "";
    pkg.status = pkg.arrivedAt ? "arrived" : "pending";
    await savePackages(packages);
    sendJson(res, 200, { package: publicPackage(pkg) });
    return;
  }

  sendJson(res, 404, { error: "Not found." });
}

async function serveStatic(res, pathname) {
  const pageAliases = {
    "/": "index.html",
    "/privacy": "privacy.html",
    "/terms": "terms.html",
    "/tiktok-compliance": "tiktok-compliance.html"
  };
  const filePath = join(publicDir, pageAliases[pathname] || pathname);
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
