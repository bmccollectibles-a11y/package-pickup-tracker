const rows = document.querySelector("#packageRows");
const addForm = document.querySelector("#addForm");
const refreshButton = document.querySelector("#refreshButton");
const emailButton = document.querySelector("#emailButton");
const smsButton = document.querySelector("#smsButton");
const statusMessage = document.querySelector("#statusMessage");
const recipientSettingsButton = document.querySelector("#recipientSettingsButton");
const recipientDialog = document.querySelector("#recipientDialog");
const closeRecipientDialog = document.querySelector("#closeRecipientDialog");
const adminPasswordForm = document.querySelector("#adminPasswordForm");
const adminPassword = document.querySelector("#adminPassword");
const recipientSections = document.querySelector("#recipientSections");
const emailRecipientForm = document.querySelector("#emailRecipientForm");
const recipientEmail = document.querySelector("#recipientEmail");
const emailRecipientList = document.querySelector("#emailRecipientList");
const smsRecipientForm = document.querySelector("#smsRecipientForm");
const recipientPhone = document.querySelector("#recipientPhone");
const smsRecipientList = document.querySelector("#smsRecipientList");
const recipientSource = document.querySelector("#recipientSource");
const tabs = [...document.querySelectorAll(".tab")];
let packages = [];
let emailRecipients = [];
let smsRecipients = [];
let usingEnvEmailRecipients = false;
let usingEnvSmsRecipients = false;
let config = { smsEnabled: false, smsConfigured: false };
let recipientAdminToken = window.sessionStorage.getItem("recipientAdminToken") || "";
let recipientsLoaded = false;
let filter = "active";
let editingId = null;

function setMessage(message, isError = false) {
  statusMessage.textContent = message;
  statusMessage.style.color = isError ? "#b91c1c" : "#667064";
}

async function api(path, options = {}) {
  const timeoutMs = options.timeoutMs || 30000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, {
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      ...options,
      signal: controller.signal
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Request failed");
    return payload;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("The status check is taking too long. Verify the Shippo settings in Render, then try again.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function adminHeaders() {
  return recipientAdminToken ? { Authorization: `Bearer ${recipientAdminToken}` } : {};
}

function fmtDate(value) {
  if (!value) return "Never";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function fmtEta(value) {
  return value ? fmtDate(value) : "No ETA";
}

function statusLabel(status) {
  return {
    pending: "Pending",
    in_transit: "In transit",
    out_for_delivery: "Out for delivery",
    arrived: "Ready",
    picked_up: "Received",
    check_failed: "Check failed"
  }[status] || status;
}

function carrierLabel(carrier) {
  return {
    auto: "Carrier",
    ups: "UPS",
    fedex: "FedEx",
    usps: "USPS"
  }[carrier] || carrier || "Carrier";
}

function packageCarrierLabel(pkg) {
  return carrierLabel(pkg.carrier === "auto" ? pkg.resolvedCarrier : pkg.carrier);
}

function trackingUrl(pkg) {
  const number = encodeURIComponent(pkg.trackingNumber);
  const carrier = pkg.carrier === "auto" ? pkg.resolvedCarrier : pkg.carrier;
  if (carrier === "ups") return `https://www.ups.com/track?track=yes&trackNums=${number}`;
  if (carrier === "fedex") return `https://www.fedex.com/fedextrack/?trknbr=${number}`;
  if (carrier === "usps") return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${number}`;
  return "";
}

function etaSortValue(pkg) {
  if (!pkg.eta) return Number.MAX_SAFE_INTEGER;
  const time = new Date(pkg.eta).getTime();
  return Number.isNaN(time) ? Number.MAX_SAFE_INTEGER : time;
}

function dateSortValue(value, fallback = 0) {
  if (!value) return fallback;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? fallback : time;
}

function sortByEtaThenCreated(items) {
  return [...items].sort((a, b) => etaSortValue(a) - etaSortValue(b) || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

function activeStatusSortValue(pkg) {
  return {
    arrived: 0,
    out_for_delivery: 1,
    in_transit: 2,
    pending: 3,
    check_failed: 4
  }[pkg.status] ?? 5;
}

function activeSortValue(pkg) {
  if (pkg.status === "arrived") {
    return -dateSortValue(pkg.arrivedAt || pkg.lastCheckedAt || pkg.createdAt);
  }
  return etaSortValue(pkg);
}

function sortActivePackages(items) {
  return [...items].sort(
    (a, b) =>
      activeStatusSortValue(a) - activeStatusSortValue(b) ||
      activeSortValue(a) - activeSortValue(b) ||
      dateSortValue(a.createdAt) - dateSortValue(b.createdAt)
  );
}

function visiblePackages() {
  if (filter === "needs_pickup") return sortActivePackages(packages.filter((pkg) => pkg.status === "arrived" && !pkg.pickedUpAt));
  if (filter === "out_for_delivery") return sortByEtaThenCreated(packages.filter((pkg) => pkg.status === "out_for_delivery" && !pkg.pickedUpAt));
  if (filter === "active") {
    return sortActivePackages(packages.filter((pkg) => !pkg.pickedUpAt));
  }
  if (filter === "picked_up") return packages.filter((pkg) => pkg.pickedUpAt);
  return sortByEtaThenCreated(packages);
}

function updateCounts() {
  document.querySelector("#pickupCount").textContent = packages.filter((pkg) => pkg.status === "arrived" && !pkg.pickedUpAt).length;
  document.querySelector("#activeCount").textContent = packages.filter((pkg) => !pkg.pickedUpAt).length;
  document.querySelector("#outForDeliveryCount").textContent = packages.filter((pkg) => pkg.status === "out_for_delivery" && !pkg.pickedUpAt).length;
  document.querySelector("#pickedUpCount").textContent = packages.filter((pkg) => pkg.pickedUpAt).length;
}

function render() {
  updateCounts();
  const visible = visiblePackages();
  rows.innerHTML = "";

  if (!visible.length) {
    rows.innerHTML = `<tr><td colspan="6" class="empty">No packages in this view.</td></tr>`;
    return;
  }

  for (const pkg of visible) {
    const tr = document.createElement("tr");
    tr.className = `package-row package-row-${pkg.status}`;
    tr.innerHTML = `
      <td data-label="Tracking">${trackingMarkup(pkg)}</td>
      <td data-label="Status"><span class="pill ${pkg.status}">${statusLabel(pkg.status)}</span></td>
      <td data-label="Carrier update">${pkg.carrierStatus || ""}</td>
      <td data-label="ETA">${etaMarkup(pkg)}</td>
      <td data-label="Last checked">${fmtDate(pkg.lastCheckedAt)}</td>
      <td data-label="Action">${actionMarkup(pkg)}</td>
    `;
    rows.appendChild(tr);
  }
}

function etaMarkup(pkg) {
  if (!pkg.eta) return `<span class="note inline-note">No ETA</span>`;
  return `
    <span class="eta">${fmtEta(pkg.eta)}</span>
    ${pkg.originalEta && pkg.originalEta !== pkg.eta ? `<span class="note">Original ${fmtEta(pkg.originalEta)}</span>` : ""}
  `;
}

function trackingMarkup(pkg) {
  const url = trackingUrl(pkg);
  const trackingNumberMarkup = url
    ? `<a class="tracking tracking-link" href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${pkg.trackingNumber}</a>`
    : `<span class="tracking">${pkg.trackingNumber}</span>`;

  if (editingId === pkg.id) {
    return `
      ${trackingNumberMarkup}
      <div class="edit-row">
        <input class="description-input" data-description-input="${pkg.id}" value="${escapeAttr(pkg.description || "")}" placeholder="Description">
        <input class="seller-input" data-seller-input="${pkg.id}" value="${escapeAttr(pkg.seller || "")}" placeholder="Seller (optional)">
        ${pkg.pickedUpAt ? `
          <input class="received-by-input" data-received-by-input="${pkg.id}" value="${escapeAttr(pkg.receivedBy || "")}" placeholder="Received by (optional)">
          <input class="received-note-input" data-received-note-input="${pkg.id}" value="${escapeAttr(pkg.receivedNote || "")}" placeholder="Received note (optional)">
        ` : ""}
        <button class="secondary compact" data-save-description="${pkg.id}">Save</button>
        <button class="secondary compact" data-cancel-edit="${pkg.id}">Cancel</button>
      </div>
    `;
  }

  return `
    <span class="tracking-block">
      ${trackingNumberMarkup}
      <span class="carrier-badge">${packageCarrierLabel(pkg)}</span>
    </span>
    ${pkg.seller ? `<span class="note">Seller: ${escapeHtml(pkg.seller)}</span>` : ""}
    ${pkg.description ? `<span class="note">${escapeHtml(pkg.description)}</span>` : ""}
  `;
}

function carrierOptionMarkup(selectedCarrier) {
  return ["auto", "ups", "fedex", "usps"]
    .map((carrier) => `<option value="${carrier}"${carrier === selectedCarrier ? " selected" : ""}>${carrierLabel(carrier)}</option>`)
    .join("");
}

function actionMarkup(pkg) {
  const primaryAction = pkg.pickedUpAt
    ? `<button class="secondary" data-unpickup="${pkg.id}">Mark not received</button>`
    : `<button class="secondary" data-pickup="${pkg.id}">Mark received</button>`;
  const rowActions = `
    ${primaryAction}
    <button class="secondary compact" data-edit-description="${pkg.id}">Edit</button>
    <button class="danger compact" data-delete-package="${pkg.id}">Delete</button>
  `;
  const actionMenu = `
    <details class="action-menu">
      <summary>Actions</summary>
      <div class="action-menu-items">
        ${rowActions}
      </div>
    </details>
  `;

  if (pkg.pickedUpAt) {
    return `
      <span class="note action-note">${receivedSummary(pkg)}</span>
      <div class="row-actions desktop-actions">
        ${rowActions}
      </div>
      ${actionMenu}
    `;
  }

  return `
    <div class="row-actions desktop-actions">
      ${rowActions}
    </div>
    ${actionMenu}
  `;
}

function receivedSummary(pkg) {
  const parts = [`Received ${fmtDate(pkg.pickedUpAt)}`];
  if (pkg.receivedBy) parts.push(`by ${pkg.receivedBy}`);
  if (pkg.receivedNote) parts.push(`- ${pkg.receivedNote}`);
  return escapeHtml(parts.join(" "));
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("`", "&#96;");
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

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!email) return "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error(`Enter ${email} as a valid email address.`);
  }
  return email;
}

function recipientListMarkup(recipients, removeAttribute, emptyText) {
  if (!recipients.length) {
    return `<span class="note inline-note">${emptyText}</span>`;
  }
  return recipients
    .map(
      (recipient) => `
        <span class="recipient-chip">
          ${escapeHtml(recipient)}
          <button type="button" aria-label="Remove ${escapeAttr(recipient)}" ${removeAttribute}="${escapeAttr(recipient)}">x</button>
        </span>
      `
    )
    .join("");
}

function renderRecipients() {
  const unlocked = Boolean(recipientAdminToken);
  adminPasswordForm.hidden = unlocked;
  recipientSections.hidden = !unlocked;

  if (!unlocked) {
    recipientSource.textContent = "Enter the admin password to view and edit alert recipients.";
    emailRecipientList.innerHTML = "";
    smsRecipientList.innerHTML = "";
    return;
  }

  if (!recipientsLoaded) {
    recipientSource.textContent = "Loading recipients...";
    emailRecipientList.innerHTML = "";
    smsRecipientList.innerHTML = "";
    return;
  }

  const fallbackText = [usingEnvEmailRecipients ? "email" : "", usingEnvSmsRecipients ? "text" : ""].filter(Boolean).join(" and ");
  recipientSource.textContent = fallbackText
    ? `Using Render ${fallbackText} recipients until you save changes here.`
    : "Changes save to the persistent Render disk.";

  emailRecipientList.innerHTML = recipientListMarkup(emailRecipients, "data-remove-email-recipient", "No email recipients configured.");
  smsRecipientList.innerHTML = recipientListMarkup(smsRecipients, "data-remove-sms-recipient", "No text recipients configured.");
}

async function loadNotificationSettings() {
  const payload = await api("/api/notification-settings", { headers: adminHeaders() });
  emailRecipients = payload.emailRecipients || [];
  smsRecipients = payload.smsRecipients || [];
  usingEnvEmailRecipients = Boolean(payload.usingEnvEmailRecipients);
  usingEnvSmsRecipients = Boolean(payload.usingEnvSmsRecipients);
  recipientsLoaded = true;
  renderRecipients();
}

async function saveRecipients(nextRecipients, message) {
  const body = {
    emailRecipients: nextRecipients.emailRecipients ?? emailRecipients,
    smsRecipients: nextRecipients.smsRecipients ?? smsRecipients
  };
  const payload = await api("/api/notification-settings", {
    method: "PUT",
    headers: adminHeaders(),
    body: JSON.stringify(body)
  });
  emailRecipients = payload.emailRecipients || [];
  smsRecipients = payload.smsRecipients || [];
  usingEnvEmailRecipients = Boolean(payload.usingEnvEmailRecipients);
  usingEnvSmsRecipients = Boolean(payload.usingEnvSmsRecipients);
  recipientsLoaded = true;
  renderRecipients();
  setMessage(message);
}

function notificationMessage(payload) {
  const notified = payload.notifiedReadyForPickup || [];
  const readyCount = notified.filter((pkg) => pkg.status === "arrived").length;
  const outForDeliveryCount = notified.filter((pkg) => pkg.status === "out_for_delivery").length;
  const totalCount = notified.length;
  const sent = payload.notifications?.filter((item) => item.sent).map((item) => item.sent) || [];
  const errors = payload.notifications?.filter((item) => item.error) || [];

  if (!totalCount) return "No packages are currently ready or out for delivery.";
  const summary = `${readyCount} ready, ${outForDeliveryCount} out for delivery`;
  if (sent.includes("email") && sent.includes("sms")) return `Email and text sent for ${summary}.`;
  if (sent.includes("email")) return `Email sent for ${summary}.`;
  if (sent.includes("sms")) return `Text sent for ${summary}.`;
  if (errors.length) return `Notification failed for ${summary}.`;
  return `${summary}, but notifications are not configured.`;
}

function refreshMessage(payload) {
  const errorText = payload.errors?.length ? ` ${payload.errors.length} check failed.` : "";
  const outForDeliveryText = payload.newlyOutForDelivery?.length ? ` ${payload.newlyOutForDelivery.length} newly out for delivery.` : "";
  return `Refresh complete. ${payload.newlyArrived?.length || 0} newly ready.${outForDeliveryText}${errorText}`;
}

function updateSmsButton() {
  smsButton.disabled = !config.smsEnabled;
  smsButton.title = config.smsEnabled ? "" : "Text alerts are disabled until SMS_ENABLED=true.";
}

async function loadConfig() {
  config = await api("/api/config");
  updateSmsButton();
}

async function loadPackages() {
  const payload = await api("/api/packages");
  packages = payload.packages;
  render();
}

addForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(addForm);
  try {
    const payload = await api("/api/packages", {
      method: "POST",
      body: JSON.stringify({
        trackingNumbers: form.get("trackingNumbers"),
        description: form.get("description"),
        carrier: form.get("carrier")
      })
    });
    addForm.reset();
    setMessage(`Added ${payload.added.length}. Skipped ${payload.skippedDuplicates} duplicate${payload.skippedDuplicates === 1 ? "" : "s"}.`);
    await loadPackages();
  } catch (error) {
    setMessage(error.message, true);
  }
});

refreshButton.addEventListener("click", async () => {
  refreshButton.disabled = true;
  setMessage("Checking package statuses...");
  try {
    const payload = await api("/api/refresh", { method: "POST", timeoutMs: 75000 });
    packages = payload.packages;
    setMessage(refreshMessage(payload), Boolean(payload.errors?.length));
    render();
  } catch (error) {
    setMessage(error.message, true);
  } finally {
    refreshButton.disabled = false;
  }
});

emailButton.addEventListener("click", async () => {
  emailButton.disabled = true;
  setMessage("Sending email alert...");
  try {
    const payload = await api("/api/notify/email", { method: "POST" });
    packages = payload.packages;
    setMessage(notificationMessage(payload), payload.notifications?.some((item) => item.error));
    render();
  } catch (error) {
    setMessage(error.message, true);
  } finally {
    emailButton.disabled = false;
  }
});

smsButton.addEventListener("click", async () => {
  smsButton.disabled = true;
  setMessage("Sending text alert...");
  try {
    const payload = await api("/api/notify/sms", { method: "POST" });
    packages = payload.packages;
    setMessage(notificationMessage(payload), payload.notifications?.some((item) => item.error));
    render();
  } catch (error) {
    setMessage(error.message, true);
  } finally {
    updateSmsButton();
  }
});

recipientSettingsButton.addEventListener("click", async () => {
  recipientDialog.showModal();
  renderRecipients();
  if (recipientAdminToken) {
    try {
      await loadNotificationSettings();
      recipientEmail.focus();
    } catch (error) {
      recipientAdminToken = "";
      recipientsLoaded = false;
      window.sessionStorage.removeItem("recipientAdminToken");
      renderRecipients();
      setMessage(error.message, true);
      adminPassword.focus();
    }
  } else {
    adminPassword.focus();
  }
});

closeRecipientDialog.addEventListener("click", () => {
  recipientDialog.close();
});

recipientDialog.addEventListener("click", (event) => {
  if (event.target === recipientDialog) {
    recipientDialog.close();
  }
});

adminPasswordForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = adminPassword.value;
  if (!password) return;
  recipientAdminToken = password;
  try {
    await loadNotificationSettings();
    window.sessionStorage.setItem("recipientAdminToken", recipientAdminToken);
    adminPassword.value = "";
    setMessage("Recipients unlocked.");
    recipientEmail.focus();
  } catch (error) {
    recipientAdminToken = "";
    recipientsLoaded = false;
    window.sessionStorage.removeItem("recipientAdminToken");
    renderRecipients();
    setMessage(error.message, true);
    adminPassword.focus();
  }
});

emailRecipientForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const recipient = normalizeEmail(recipientEmail.value);
    if (!recipient) return;
    if (emailRecipients.includes(recipient)) {
      setMessage("That email recipient is already on the list.");
      recipientEmail.value = "";
      return;
    }
    await saveRecipients({ emailRecipients: [...emailRecipients, recipient] }, "Email recipient added.");
    recipientEmail.value = "";
  } catch (error) {
    setMessage(error.message, true);
  }
});

smsRecipientForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const recipient = normalizePhoneNumber(recipientPhone.value);
    if (!recipient) return;
    if (smsRecipients.includes(recipient)) {
      setMessage("That text recipient is already on the list.");
      recipientPhone.value = "";
      return;
    }
    await saveRecipients({ smsRecipients: [...smsRecipients, recipient] }, "Text recipient added.");
    recipientPhone.value = "";
  } catch (error) {
    setMessage(error.message, true);
  }
});

emailRecipientList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-remove-email-recipient]");
  if (!button) return;
  button.disabled = true;
  try {
    await saveRecipients(
      { emailRecipients: emailRecipients.filter((recipient) => recipient !== button.dataset.removeEmailRecipient) },
      "Email recipient removed."
    );
  } catch (error) {
    setMessage(error.message, true);
    button.disabled = false;
  }
});

smsRecipientList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-remove-sms-recipient]");
  if (!button) return;
  button.disabled = true;
  try {
    await saveRecipients(
      { smsRecipients: smsRecipients.filter((recipient) => recipient !== button.dataset.removeSmsRecipient) },
      "Text recipient removed."
    );
  } catch (error) {
    setMessage(error.message, true);
    button.disabled = false;
  }
});

rows.addEventListener("click", async (event) => {
  const editButton = event.target.closest("[data-edit-description]");
  if (editButton) {
    editingId = editButton.dataset.editDescription;
    render();
    rows.querySelector(`[data-description-input="${editingId}"]`)?.focus();
    return;
  }

  const cancelButton = event.target.closest("[data-cancel-edit]");
  if (cancelButton) {
    editingId = null;
    render();
    return;
  }

  const saveButton = event.target.closest("[data-save-description]");
  if (saveButton) {
    saveButton.disabled = true;
    const id = saveButton.dataset.saveDescription;
    const input = rows.querySelector(`[data-description-input="${id}"]`);
    const sellerInput = rows.querySelector(`[data-seller-input="${id}"]`);
    const receivedByInput = rows.querySelector(`[data-received-by-input="${id}"]`);
    const receivedNoteInput = rows.querySelector(`[data-received-note-input="${id}"]`);
    try {
      await api(`/api/packages/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          description: input?.value || "",
          seller: sellerInput?.value || "",
          receivedBy: receivedByInput?.value || "",
          receivedNote: receivedNoteInput?.value || ""
        })
      });
      editingId = null;
      setMessage("Description updated.");
      await loadPackages();
    } catch (error) {
      setMessage(error.message, true);
      saveButton.disabled = false;
    }
    return;
  }

  const deleteButton = event.target.closest("[data-delete-package]");
  if (deleteButton) {
    const id = deleteButton.dataset.deletePackage;
    const pkg = packages.find((item) => item.id === id);
    if (!window.confirm(`Delete tracking number ${pkg?.trackingNumber || ""}?`)) return;
    deleteButton.disabled = true;
    try {
      await api(`/api/packages/${id}`, { method: "DELETE" });
      setMessage("Package deleted.");
      await loadPackages();
    } catch (error) {
      setMessage(error.message, true);
      deleteButton.disabled = false;
    }
    return;
  }

  const pickupButton = event.target.closest("[data-pickup]");
  if (pickupButton) {
    pickupButton.disabled = true;
    try {
      await api(`/api/packages/${pickupButton.dataset.pickup}/pickup`, { method: "POST" });
      setMessage("Package marked received.");
      await loadPackages();
    } catch (error) {
      setMessage(error.message, true);
      pickupButton.disabled = false;
    }
    return;
  }

  const button = event.target.closest("[data-unpickup]");
  if (!button) return;
  button.disabled = true;
  const id = button.dataset.unpickup;
  try {
    await api(`/api/packages/${id}/unpickup`, { method: "POST" });
    setMessage("Package marked not received.");
    await loadPackages();
  } catch (error) {
    setMessage(error.message, true);
    button.disabled = false;
  }
});

for (const tab of tabs) {
  tab.addEventListener("click", () => {
    filter = tab.dataset.filter;
    tabs.forEach((item) => item.classList.toggle("active", item === tab));
    render();
  });
}

renderRecipients();
Promise.all([loadConfig(), loadPackages()]).catch((error) => setMessage(error.message, true));
