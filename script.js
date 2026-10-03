import { PART_LIMITS, PART_WIDTHS, parseDescription, parsePastedDescription, formatDescription, locate } from "./land.js";

const find = selector => document.querySelector(selector);
const form = find("#searchForm");
const fields = Array.from({ length: 5 }, (_, index) => find(`#part${index}`));
const result = find("#result");
const error = find("#error");
const submit = find("#findLocation");
const historyKey = "LeaseLocator.recentEntries.v1";
let activePart = 0;
let controller;
let coordinates = "";
let recentEntries = readHistory();

function readHistory() {
  try {
    const saved = JSON.parse(localStorage.getItem(historyKey) || "[]");
    if (!Array.isArray(saved)) return [];
    return [...new Set(saved.filter(value => typeof value === "string")
      .map(parseDescription).filter(Boolean).map(formatDescription))].slice(0, 30);
  } catch {
    return []; // Storage failure must not prevent lookup.
  }
}

function saveHistory() {
  try { localStorage.setItem(historyKey, JSON.stringify(recentEntries)); }
  catch { /* History remains available for this session. */ }
  renderHistory();
}

function renderHistory() {
  find("#historyEmpty").hidden = recentEntries.length > 0;
  find("#clearHistory").hidden = recentEntries.length === 0;
  find("#historyItems").replaceChildren();
  for (const entry of recentEntries) {
    const row = document.createElement("div");
    row.className = "history-row";
    const reuse = document.createElement("button");
    reuse.type = "button";
    reuse.className = "history-entry";
    reuse.textContent = entry;
    reuse.setAttribute("aria-label", `Search again for ${entry}`);
    reuse.addEventListener("click", () => { setParts(parseDescription(entry)); form.requestSubmit(); });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove-entry";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Remove ${entry} from history`);
    remove.addEventListener("click", () => {
      recentEntries = recentEntries.filter(value => value !== entry);
      saveHistory();
      find("#historyItems button")?.focus();
    });
    row.append(reuse, remove);
    find("#historyItems").append(row);
  }
}

function setLoading(loading) {
  submit.disabled = loading;
  submit.textContent = loading ? "Finding location…" : "Find location";
  form.setAttribute("aria-busy", String(loading));
  find("#status").textContent = loading ? "Looking up the survey parcel…" : "";
}

function clearResult() {
  controller?.abort();
  result.hidden = true;
  error.textContent = "";
  fields.forEach(field => field.removeAttribute("aria-invalid"));
  coordinates = "";
  find("#copyCoordinates").textContent = "Copy coordinates";
  setLoading(false);
}

function setParts(parts) {
  fields.forEach((field, index) => { field.value = String(parts[index]); });
  clearResult();
}

function advance(index) {
  if (index < 4) { fields[index + 1].focus(); fields[index + 1].select(); }
  else form.requestSubmit();
}

fields.forEach((field, index) => {
  field.addEventListener("focus", () => {
    activePart = index;
    find("#nextPart").textContent = index === 4 ? "Find location" : "Next part →";
  });
  field.addEventListener("input", () => {
    const pasted = parsePastedDescription(field.value);
    if (pasted) { setParts(pasted); fields[4].focus(); return; }
    field.value = field.value.replace(/\D/g, "").slice(0, PART_WIDTHS[index]);
    clearResult();
    if (index < 4 && field.value && (field.value.length >= PART_WIDTHS[index] || Number(field.value) * 10 > PART_LIMITS[index])) advance(index);
  });
  field.addEventListener("keydown", event => {
    if (["Enter", "-", " ", "/", "w", "W"].includes(event.key)) {
      event.preventDefault(); advance(index);
    } else if (event.key === "Backspace" && !field.value && index > 0) {
      event.preventDefault(); fields[index - 1].focus();
    }
  });
  field.addEventListener("paste", event => {
    const parts = parsePastedDescription(event.clipboardData?.getData("text") || "");
    if (parts) { event.preventDefault(); setParts(parts); fields[4].focus(); }
  });
});

find("#nextPart").addEventListener("click", () => advance(activePart));
find("#clearEntry").addEventListener("click", () => {
  fields.forEach(field => { field.value = ""; });
  clearResult();
  fields[0].focus();
});
find("#clearHistory").addEventListener("click", () => {
  if (window.confirm("Clear recent searches from this browser?")) {
    recentEntries = [];
    saveHistory();
  }
});
find("#copyCoordinates").addEventListener("click", async () => {
  const copiedCoordinates = coordinates;
  try {
    await navigator.clipboard.writeText(copiedCoordinates);
    if (coordinates === copiedCoordinates) find("#copyCoordinates").textContent = "Copied";
  } catch {
    if (coordinates === copiedCoordinates) find("#copyCoordinates").textContent = "Select coordinates to copy";
  }
});

form.addEventListener("submit", async event => {
  event.preventDefault();
  clearResult();
  const parts = parseDescription(`${fields.slice(0, 4).map(field => field.value).join("-")}W${fields[4].value}`);
  if (!parts) {
    const invalidIndex = fields.findIndex((field, index) => !/^\d+$/.test(field.value) || Number(field.value) < 1 || Number(field.value) > PART_LIMITS[index]);
    const invalidField = fields[Math.max(0, invalidIndex)];
    invalidField.setAttribute("aria-invalid", "true");
    error.textContent = "Check the description: LSD 1–16, section 1–36, township 1–127, range 1–36, meridian W1–W6.";
    invalidField.focus();
    return;
  }
  const request = new AbortController();
  controller = request;
  const timeout = setTimeout(() => request.abort("timeout"), 20000);
  setLoading(true);
  try {
    const location = await locate(parts, request.signal);
    if (request.signal.aborted) return;
    const legal = formatDescription(parts);
    coordinates = `${location.lat.toFixed(6)}, ${location.lon.toFixed(6)}`;
    find("#legalOut").textContent = legal;
    find("#coordinates").textContent = coordinates;
    find("#regionOut").textContent = location.source.region;
    find("#sourceLink").href = location.source.url;
    find("#sourceLink").textContent = location.source.name;
    find("#accuracy").textContent = location.theoretical
      ? "Calculated centre of a theoretical (unsurveyed) LSD. Confirm the parcel and access road before travelling."
      : "Calculated LSD centre. The lease entrance or wellhead may be elsewhere.";
    find("#google").href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(coordinates)}`;
    find("#apple").href = `https://maps.apple.com/?q=${encodeURIComponent(legal)}&ll=${encodeURIComponent(coordinates)}`;
    result.hidden = false;
    result.focus();
    recentEntries = [legal, ...recentEntries.filter(entry => entry !== legal)].slice(0, 30);
    saveHistory();
  } catch (failure) {
    if (controller !== request || (request.signal.aborted && request.signal.reason !== "timeout")) return;
    error.textContent = failure instanceof TypeError || request.signal.reason === "timeout"
      ? "Could not reach the survey service. Check your connection and try again."
      : failure.message || "Could not find that location. Try again.";
  } finally {
    clearTimeout(timeout);
    if (controller === request) setLoading(false);
  }
});

renderHistory();
