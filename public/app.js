const rows = document.querySelector("#packageRows");
const addForm = document.querySelector("#addForm");
const refreshButton = document.querySelector("#refreshButton");
const statusMessage = document.querySelector("#statusMessage");
const tabs = [...document.querySelectorAll(".tab")];
let packages = [];
let filter = "needs_pickup";

function setMessage(message, isError = false) {
  statusMessage.textContent = message;
  statusMessage.style.color = isError ? "#b91c1c" : "#667064";
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Request failed");
  return payload;
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

function statusLabel(status) {
  return {
    pending: "Pending",
    in_transit: "In transit",
    arrived: "Ready",
    picked_up: "Picked up",
    check_failed: "Check failed"
  }[status] || status;
}

function visiblePackages() {
  if (filter === "needs_pickup") return packages.filter((pkg) => pkg.status === "arrived" && !pkg.pickedUpAt);
  if (filter === "active") return packages.filter((pkg) => !pkg.pickedUpAt && pkg.status !== "arrived");
  if (filter === "picked_up") return packages.filter((pkg) => pkg.pickedUpAt);
  return packages;
}

function updateCounts() {
  document.querySelector("#pickupCount").textContent = packages.filter((pkg) => pkg.status === "arrived" && !pkg.pickedUpAt).length;
  document.querySelector("#activeCount").textContent = packages.filter((pkg) => !pkg.pickedUpAt && pkg.status !== "arrived").length;
  document.querySelector("#pickedUpCount").textContent = packages.filter((pkg) => pkg.pickedUpAt).length;
}

function render() {
  updateCounts();
  const visible = visiblePackages();
  rows.innerHTML = "";

  if (!visible.length) {
    rows.innerHTML = `<tr><td colspan="5" class="empty">No packages in this view.</td></tr>`;
    return;
  }

  for (const pkg of visible) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>
        <span class="tracking">${pkg.trackingNumber}</span>
        ${pkg.description ? `<span class="note">${pkg.description}</span>` : ""}
      </td>
      <td><span class="pill ${pkg.status}">${statusLabel(pkg.status)}</span></td>
      <td>${pkg.carrierStatus || ""}</td>
      <td>${fmtDate(pkg.lastCheckedAt)}</td>
      <td>${actionMarkup(pkg)}</td>
    `;
    rows.appendChild(tr);
  }
}

function actionMarkup(pkg) {
  if (pkg.pickedUpAt) {
    return `
      <span class="note action-note">Picked up ${fmtDate(pkg.pickedUpAt)}</span>
      <button class="secondary" data-unpickup="${pkg.id}">Mark not picked up</button>
    `;
  }

  return `<button class="secondary" data-pickup="${pkg.id}">Mark picked up</button>`;
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
  setMessage("Checking UPS statuses...");
  try {
    const payload = await api("/api/refresh", { method: "POST" });
    packages = payload.packages;
    const errorText = payload.errors.length ? ` ${payload.errors.length} check failed.` : "";
    setMessage(`Refresh complete. ${payload.newlyArrived.length} newly ready for pickup.${errorText}`, Boolean(payload.errors.length));
    render();
  } catch (error) {
    setMessage(error.message, true);
  } finally {
    refreshButton.disabled = false;
  }
});

rows.addEventListener("click", async (event) => {
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
