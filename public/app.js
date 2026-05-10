const rows = document.querySelector("#packageRows");
const addForm = document.querySelector("#addForm");
const refreshButton = document.querySelector("#refreshButton");
const notifyButton = document.querySelector("#notifyButton");
const statusMessage = document.querySelector("#statusMessage");
const tabs = [...document.querySelectorAll(".tab")];
let packages = [];
let filter = "needs_pickup";
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
      throw new Error("The status check is taking too long. Verify TRACKER_MODE in Render, then try again.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
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
    picked_up: "Picked up",
    check_failed: "Check failed"
  }[status] || status;
}

function etaSortValue(pkg) {
  if (!pkg.eta) return Number.MAX_SAFE_INTEGER;
  const time = new Date(pkg.eta).getTime();
  return Number.isNaN(time) ? Number.MAX_SAFE_INTEGER : time;
}

function sortByEtaThenCreated(items) {
  return [...items].sort((a, b) => etaSortValue(a) - etaSortValue(b) || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

function visiblePackages() {
  if (filter === "needs_pickup") return packages.filter((pkg) => pkg.status === "arrived" && !pkg.pickedUpAt);
  if (filter === "out_for_delivery") return sortByEtaThenCreated(packages.filter((pkg) => pkg.status === "out_for_delivery" && !pkg.pickedUpAt));
  if (filter === "active") {
    return sortByEtaThenCreated(packages.filter((pkg) => !pkg.pickedUpAt && pkg.status !== "arrived" && pkg.status !== "out_for_delivery"));
  }
  if (filter === "picked_up") return packages.filter((pkg) => pkg.pickedUpAt);
  return sortByEtaThenCreated(packages);
}

function updateCounts() {
  document.querySelector("#pickupCount").textContent = packages.filter((pkg) => pkg.status === "arrived" && !pkg.pickedUpAt).length;
  document.querySelector("#activeCount").textContent = packages.filter((pkg) => !pkg.pickedUpAt && pkg.status !== "arrived" && pkg.status !== "out_for_delivery").length;
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
    tr.innerHTML = `
      <td>${trackingMarkup(pkg)}</td>
      <td><span class="pill ${pkg.status}">${statusLabel(pkg.status)}</span></td>
      <td>${pkg.carrierStatus || ""}</td>
      <td>${etaMarkup(pkg)}</td>
      <td>${fmtDate(pkg.lastCheckedAt)}</td>
      <td>${actionMarkup(pkg)}</td>
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
        <button class="secondary compact" data-save-description="${pkg.id}">Save</button>
        <button class="secondary compact" data-cancel-edit="${pkg.id}">Cancel</button>
      </div>
    `;
  }

  return `
    <span class="tracking">${pkg.trackingNumber}</span>
    ${pkg.description ? `<span class="note">${escapeHtml(pkg.description)}</span>` : ""}
  `;
}

function actionMarkup(pkg) {
  const commonActions = `
    <div class="row-actions">
      <button class="secondary compact" data-edit-description="${pkg.id}">Edit</button>
      <button class="danger compact" data-delete-package="${pkg.id}">Delete</button>
    </div>
  `;

  if (pkg.pickedUpAt) {
    return `
      <span class="note action-note">Picked up ${fmtDate(pkg.pickedUpAt)}</span>
      <button class="secondary" data-unpickup="${pkg.id}">Mark not picked up</button>
      ${commonActions}
    `;
  }

  return `
    <button class="secondary" data-pickup="${pkg.id}">Mark picked up</button>
    ${commonActions}
  `;
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

function notificationMessage(payload) {
  const notified = payload.notifiedReadyForPickup || [];
  const readyCount = notified.filter((pkg) => pkg.status === "arrived").length;
  const outForDeliveryCount = notified.filter((pkg) => pkg.status === "out_for_delivery").length;
  const totalCount = notified.length;
  const sent = payload.notifications?.filter((item) => item.sent).map((item) => item.sent) || [];
  const errors = payload.notifications?.filter((item) => item.error) || [];

  if (!totalCount) return "No packages are currently ready or out for delivery.";
  const summary = `${readyCount} ready, ${outForDeliveryCount} out for delivery`;
  if (sent.includes("email")) return `Email sent for ${summary}.`;
  if (errors.length) return `Email failed for ${summary}.`;
  return `${summary}, but email is not configured.`;
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
        description: form.get("description")
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
    const errorText = payload.errors.length ? ` ${payload.errors.length} check failed.` : "";
    const emailMessage = notificationMessage(payload);
    const outForDeliveryText = payload.newlyOutForDelivery?.length ? ` ${payload.newlyOutForDelivery.length} newly out for delivery.` : "";
    setMessage(
      `Refresh complete. ${payload.newlyArrived.length} newly ready.${outForDeliveryText} ${emailMessage}${errorText}`,
      Boolean(payload.errors.length || payload.notifications?.some((item) => item.error))
    );
    render();
  } catch (error) {
    setMessage(error.message, true);
  } finally {
    refreshButton.disabled = false;
  }
});

notifyButton.addEventListener("click", async () => {
  notifyButton.disabled = true;
  setMessage("Sending pickup email...");
  try {
    const payload = await api("/api/notify", { method: "POST" });
    packages = payload.packages;
    const emailMessage = notificationMessage(payload);
    setMessage(emailMessage, payload.notifications?.some((item) => item.error));
    render();
  } catch (error) {
    setMessage(error.message, true);
  } finally {
    notifyButton.disabled = false;
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
    try {
      await api(`/api/packages/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ description: input?.value || "" })
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

  const button = event.target.closest("[data-pickup], [data-unpickup]");
  if (!button) return;
  button.disabled = true;
  const isUnpickup = Boolean(button.dataset.unpickup);
  const id = button.dataset.pickup || button.dataset.unpickup;
  try {
    await api(`/api/packages/${id}/${isUnpickup ? "unpickup" : "pickup"}`, { method: "POST" });
    setMessage(isUnpickup ? "Package marked not picked up." : "Package marked picked up.");
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

loadPackages().catch((error) => setMessage(error.message, true));
