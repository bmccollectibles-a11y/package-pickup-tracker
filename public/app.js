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
const recipientForm = document.querySelector("#recipientForm");
const recipientPhone = document.querySelector("#recipientPhone");
const recipientList = document.querySelector("#recipientList");
const recipientSource = document.querySelector("#recipientSource");
const receiveDialog = document.querySelector("#receiveDialog");
const closeReceiveDialog = document.querySelector("#closeReceiveDialog");
const cancelReceiveButton = document.querySelector("#cancelReceiveButton");
const receiveForm = document.querySelector("#receiveForm");
const receiveTrackingNumber = document.querySelector("#receiveTrackingNumber");
const receivedBy = document.querySelector("#receivedBy");
const receivedNote = document.querySelector("#receivedNote");
const tabs = [...document.querySelectorAll(".tab")];
let packages = [];
let smsRecipients = [];
let usingEnvSmsRecipients = false;
let config = { smsEnabled: false, smsConfigured: false };
let recipientAdminToken = window.sessionStorage.getItem("recipientAdminToken") || "";
let filter = "active";
let editingId = null;
let pendingReceiveId = null;

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
  if (editingId === pkg.id) {
    return `
      <span class="tracking">${pkg.trackingNumber}</span>
      <div class="edit-row">
        <input class="description-input" data-description-input="${pkg.id}" value="${escapeAttr(pkg.description || "")}" placeholder="Description">
        <input class="seller-input" data-seller-input="${pkg.id}" value="${escapeAttr(pkg.seller || "")}" placeholder="Seller (optional)">
        <button class="secondary compact" data-save-description="${pkg.id}">Save</button>
        <button class="secondary compact" data-cancel-edit="${pkg.id}">Cancel</button>
      </div>
    `;
  }

  return `
    <span class="tracking-block">
      <span class="tracking">${pkg.trackingNumber}</span>
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

function renderRecipients() {
  const unlocked = Boolean(recipientAdminToken);
  adminPasswordForm.hidden = unlocked;
  recipientForm.hidden = !unlocked;
  recipientList.hidden = !unlocked;

  if (!unlocked) {
    recipientSource.textContent = "Enter the admin password to view and edit text recipients.";
    recipientList.innerHTML = "";
    return;
  }

  recipientSource.textContent = usingEnvSmsRecipients
    ? "Using the Render phone list until you save changes here."
    : "Changes save to the persistent Render disk.";

  if (!smsRecipients.length) {
    recipientList.innerHTML = `<span class="note inline-note">No text recipients configured.</span>`;
    return;
  }

  recipientList.innerHTML = smsRecipients
    .map(
      (recipient) => `
        <span class="recipient-chip">
          ${escapeHtml(recipient)}
          <button type="button" aria-label="Remove ${escapeAttr(recipient)}" data-remove-recipient="${escapeAttr(recipient)}">x</button>
        </span>
      `
    )
    .join("");
}

async function loadNotificationSettings() {
  const payload = await api("/api/notification-settings", { headers: adminHeaders() });
  smsRecipients = payload.smsRecipients || [];
  usingEnvSmsRecipients = Boolean(payload.usingEnvSmsRecipients);
  renderRecipients();
}

async function saveSmsRecipients(nextRecipients, message) {
  const payload = await api("/api/notification-settings", {
    method: "PUT",
    headers: adminHeaders(),
    body: JSON.stringify({ smsRecipients: nextRecipients })
  });
  smsRecipients = payload.smsRecipients || [];
  usingEnvSmsRecipients = false;
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

function openReceiveDialog(id) {
  const pkg = packages.find((item) => item.id === id);
  pendingReceiveId = id;
  receiveTrackingNumber.textContent = pkg?.trackingNumber || "";
  receivedBy.value = "";
  receivedNote.value = "";
  receiveDialog.showModal();
  receivedBy.focus();
}

function closeReceiveDialogView() {
  pendingReceiveId = null;
  receiveDialog.close();
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

recipientSettingsButton.addEventListener("click", () => {
  recipientDialog.showModal();
  renderRecipients();
  (recipientAdminToken ? recipientPhone : adminPassword).focus();
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
    setMessage("Text recipients unlocked.");
    recipientPhone.focus();
  } catch (error) {
    recipientAdminToken = "";
    window.sessionStorage.removeItem("recipientAdminToken");
    renderRecipients();
    setMessage(error.message, true);
    adminPassword.focus();
  }
});

recipientForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const recipient = normalizePhoneNumber(recipientPhone.value);
    if (!recipient) return;
    if (smsRecipients.includes(recipient)) {
      setMessage("That text recipient is already on the list.");
      recipientPhone.value = "";
      return;
    }
    await saveSmsRecipients([...smsRecipients, recipient], "Text recipient added.");
    recipientPhone.value = "";
  } catch (error) {
    setMessage(error.message, true);
  }
});

recipientList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-remove-recipient]");
  if (!button) return;
  button.disabled = true;
  try {
    await saveSmsRecipients(
      smsRecipients.filter((recipient) => recipient !== button.dataset.removeRecipient),
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
    try {
      await api(`/api/packages/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          description: input?.value || "",
          seller: sellerInput?.value || ""
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
    openReceiveDialog(pickupButton.dataset.pickup);
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

closeReceiveDialog.addEventListener("click", closeReceiveDialogView);
cancelReceiveButton.addEventListener("click", closeReceiveDialogView);

receiveDialog.addEventListener("click", (event) => {
  if (event.target === receiveDialog) {
    closeReceiveDialogView();
  }
});

receiveForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!pendingReceiveId) return;
  const id = pendingReceiveId;
  try {
    await api(`/api/packages/${id}/pickup`, {
      method: "POST",
      body: JSON.stringify({
        receivedBy: receivedBy.value,
        receivedNote: receivedNote.value
      })
    });
    closeReceiveDialogView();
    setMessage("Package marked received.");
    await loadPackages();
  } catch (error) {
    setMessage(error.message, true);
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
