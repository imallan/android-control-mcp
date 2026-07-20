const token = new URLSearchParams(location.hash.slice(1)).get("token") ?? "";
const state = { snapshot: null, frameUrl: null, selectedRef: null, refreshing: false, timer: null };
const colors = { accessibility: "#43d9a3", ocr: "#ffbf4b", vision: "#ba8cff" };
const screen = document.querySelector("#screen");
const overlay = document.querySelector("#overlay");
const outline = document.querySelector("#outline");
const summary = document.querySelector("#summary");
const notice = document.querySelector("#notice");
const detail = document.querySelector("#detail");
const refreshButton = document.querySelector("#refresh");
const live = document.querySelector("#live");

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(options.headers ?? {}) } });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText }));
    throw new Error(error.message ?? error.error ?? `HTTP ${response.status}`);
  }
  return response;
}

async function refresh() {
  if (state.refreshing) return;
  state.refreshing = true;
  refreshButton.disabled = true;
  setNotice("Refreshing…");
  try {
    const response = await api("/api/refresh", { method: "POST", body: "{}" });
    await applySnapshot(await response.json());
    setNotice(`${state.snapshot.lineCount} outlined / ${state.snapshot.nodeCount} semantic nodes · OCR ${state.snapshot.ocrUsed ? "on" : "off"} · CV ${state.snapshot.visionUsed ? "on" : "off"}`);
  } catch (error) {
    setNotice(error.message, true);
  } finally {
    state.refreshing = false;
    refreshButton.disabled = false;
  }
}

async function applySnapshot(snapshot) {
    state.snapshot = snapshot;
    const frame = await api(`/api/frame?snapshotId=${encodeURIComponent(state.snapshot.snapshotId)}`);
    if (state.frameUrl) URL.revokeObjectURL(state.frameUrl);
    state.frameUrl = URL.createObjectURL(await frame.blob());
    screen.src = state.frameUrl;
    outline.textContent = state.snapshot.outline;
    summary.textContent = `${state.snapshot.deviceId} · ${state.snapshot.packageName ?? "unknown package"} · display ${state.snapshot.displayId} · ${state.snapshot.snapshotId}`;
    renderOverlay();
    renderDetail();
}

function visibleEntries() {
  if (!state.snapshot) return [];
  const enabled = new Set([...document.querySelectorAll("[data-source]:checked")].map((input) => input.dataset.source));
  const actionableOnly = document.querySelector("#actionable").checked;
  return state.snapshot.entries.filter((entry) => enabled.has(entry.source) && (!actionableOnly || entry.actionable));
}

function renderOverlay() {
  if (!state.snapshot) return;
  overlay.setAttribute("viewBox", `0 0 ${state.snapshot.width} ${state.snapshot.height}`);
  overlay.replaceChildren(...visibleEntries().map((entry) => {
    const [left, top, right, bottom] = entry.bounds;
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", left);
    rect.setAttribute("y", top);
    rect.setAttribute("width", Math.max(1, right - left));
    rect.setAttribute("height", Math.max(1, bottom - top));
    rect.setAttribute("class", `node${entry.windowIndex > 0 ? " secondary" : ""}${entry.ref === state.selectedRef ? " selected" : ""}`);
    rect.style.setProperty("--node-color", colors[entry.source]);
    rect.dataset.ref = entry.ref;
    rect.addEventListener("click", () => { state.selectedRef = entry.ref; renderOverlay(); renderDetail(); });
    return rect;
  }));
}

function renderDetail() {
  const entry = state.snapshot?.entries.find((item) => item.ref === state.selectedRef);
  if (!entry) {
    detail.innerHTML = "<p>Select a box to inspect it.</p>";
    return;
  }
  const actionButton = state.snapshot.allowActions && entry.source === "accessibility" && entry.actionable
    ? `<button id="tap" type="button">Tap ${escapeHtml(entry.ref)}</button>`
    : "";
  detail.innerHTML = `<dl><dt>ref</dt><dd>${escapeHtml(entry.ref)}</dd><dt>label</dt><dd>${escapeHtml(entry.label)}</dd><dt>role</dt><dd>${escapeHtml(entry.role)}</dd><dt>source</dt><dd>${escapeHtml(entry.source)}</dd><dt>bounds</dt><dd>${escapeHtml(JSON.stringify(entry.bounds))}</dd><dt>window</dt><dd>${entry.windowIndex}</dd><dt>states</dt><dd>${escapeHtml(entry.states.join(", ") || "—")}</dd></dl>${actionButton}`;
  document.querySelector("#tap")?.addEventListener("click", () => tap(entry));
}

async function tap(entry) {
  setNotice(`Tapping ${entry.ref}…`);
  try {
    const response = await api("/api/tap", { method: "POST", body: JSON.stringify({ snapshotId: state.snapshot.snapshotId, ref: entry.ref }) });
    const result = await response.json();
    if (!result.success) throw new Error(result.action?.message ?? result.message ?? "Tap failed");
    await applySnapshot(result.snapshot);
    setNotice(`${entry.ref}: ${result.action?.status ?? "completed"}`);
  } catch (error) {
    setNotice(error.message, true);
  }
}

function setNotice(message, error = false) {
  notice.textContent = message;
  notice.classList.toggle("error", error);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char]);
}

refreshButton.addEventListener("click", refresh);
document.querySelectorAll(".filters input").forEach((input) => input.addEventListener("change", renderOverlay));
live.addEventListener("change", () => {
  clearInterval(state.timer);
  state.timer = live.checked ? setInterval(() => { if (!document.hidden) refresh(); }, 1000) : null;
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && live.checked) refresh();
});
if (!token) setNotice("Missing Viewer session token.", true); else refresh();
