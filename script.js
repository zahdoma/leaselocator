const $ = (selector) => document.querySelector(selector);
const form = $("#searchForm"), input = $("#lsd"), result = $("#result"), error = $("#error");
const button = form.querySelector('[type="submit"]');
const fields = Array.from({ length: 5 }, (_, i) => $("#part" + i));
let activePart = 0;
let requestVersion = 0;
const historyKey = "LeaseLocator.recentEntries.v1";
let recentEntries = [];
try {
  const saved = JSON.parse(localStorage.getItem(historyKey) || "[]");
  if (Array.isArray(saved)) recentEntries = [...new Set(saved.filter((value) => typeof value === "string" && parse(value)).map((value) => canonical(parse(value))))].slice(0, 30);
} catch {}
function saveHistory() {
  try { localStorage.setItem(historyKey, JSON.stringify(recentEntries)); } catch {}
  renderHistory();
}
function renderHistory() {
  $("#history").hidden = recentEntries.length === 0;
  $("#historyItems").replaceChildren();
  for (const value of recentEntries) {
    const row = document.createElement("div");
    row.className = "history-row";
    const reuse = document.createElement("button");
    reuse.type = "button";
    reuse.textContent = value;
    reuse.onclick = () => {
      setParts(parse(value));
      form.requestSubmit();
    };
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", "Remove " + value + " from history");
    remove.onclick = () => {
      recentEntries = recentEntries.filter((entry) => entry !== value);
      saveHistory();
    };
    row.append(reuse, remove);
    $("#historyItems").append(row);
  }
}
$("#clearHistory").onclick = () => {
  if (window.confirm("Clear recent searches?")) {
    recentEntries = [];
    saveHistory();
  }
};
renderHistory();
function parse(value) {
  const match = value.trim().match(/^(\d{1,2})[- /]+(\d{1,2})[- /]+(\d{1,3})[- /]+(\d{1,2})[- /]*w\s*([4-6])$/i);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every((n, i) => n >= 1 && n <= [16, 36, 127, 36, 6][i]) ? parts : null;
}
function canonical(parts) {
  return parts.slice(0, 4).join("-") + "W" + parts[4];
}
function updateEntry() {
  input.value = fields.slice(0, 4).map(field => field.value).join("-") + "W" + fields[4].value;
  ++requestVersion;
  result.hidden = true;
  error.textContent = "";
  button.disabled = false;
  button.textContent = "Find on maps";
}
function setParts(parts) {
  fields.forEach((field, i) => { field.value = String(parts[i]); });
  updateEntry();
}
function advance(i) {
  if (i < 4) { fields[i + 1].focus(); fields[i + 1].select(); }
  else form.requestSubmit();
}
function pastedParts(value) {
  const formatted = parse(value);
  if (formatted) return formatted;
  // Compact full entries use two digits per part, with two or three for township.
  const match = value.trim().match(/^(\d{2})(\d{2})(\d{2,3})(\d{2})([4-6])$/);
  return match ? parse(`${match[1]}-${match[2]}-${match[3]}-${match[4]}W${match[5]}`) : null;
}
fields.forEach((field, i) => {
  field.addEventListener("focus", () => {
    activePart = i;
    $("#nextPart").textContent = i === 4 ? "Find on maps" : "Next part";
  });
  field.addEventListener("input", () => {
    const full = pastedParts(field.value);
    if (full) { setParts(full); fields[4].focus(); return; }
    field.value = field.value.replace(/\D/g, "").slice(0, [2, 2, 3, 2, 1][i]);
    updateEntry();
    const value = field.value;
    // Advance once no valid additional digit can belong to this part.
    const max = [16, 36, 127, 36, 6][i];
    if (i < 4 && value && (value.length >= [2, 2, 3, 2, 1][i] || Number(value) * 10 > max)) advance(i);
  });
  field.addEventListener("keydown", (event) => {
    if (["Enter", "-", " ", "/", "w", "W"].includes(event.key)) {
      event.preventDefault(); advance(i);
    } else if (event.key === "Backspace" && !field.value && i > 0) {
      event.preventDefault(); fields[i - 1].focus();
    }
  });
  field.addEventListener("paste", (event) => {
    const parts = pastedParts(event.clipboardData?.getData("text") || "");
    if (parts) { event.preventDefault(); setParts(parts); fields[4].focus(); }
  });
});
$("#nextPart").addEventListener("click", () => advance(activePart));
function ringCentroid(ring) {
  let area = 0,
    x = 0,
    y = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j],
      b = ring[i],
      cross = a[0] * b[1] - b[0] * a[1];
    area += cross;
    x += (a[0] + b[0]) * cross;
    y += (a[1] + b[1]) * cross;
  }
  area *= 0.5;
  return Math.abs(area) > 1e-12
    ? { lon: x / (6 * area), lat: y / (6 * area), area: Math.abs(area) }
    : { lon: ring[0][0], lat: ring[0][1], area: 0 };
}
async function locate([lsd, sec, twp, rng, mer]) {
  const where = `M=${mer} AND RGE=${rng} AND TWP=${twp} AND SEC=${sec} AND LS=${lsd}`;
  const params = new URLSearchParams({
    where,
    outFields: "PID,M,RGE,TWP,SEC,LS,RA",
    returnGeometry: "true",
    outSR: "4326",
    f: "geojson",
  });
  const url =
    "https://geospatial.alberta.ca/titan/rest/services/base/alberta_township_system/MapServer/20/query?" +
    params;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error("ATS service unavailable");
  const data = await response.json();
  if (data.error)
    throw new Error(data.error.message || "ATS service unavailable");
  const candidates = (data.features || []).filter(
    (f) => f.geometry?.coordinates?.length,
  );
  if (!candidates.length)
    throw new Error("No ATS v4.1 location was found for that description.");
  const parcel =
    candidates.find((f) => !String(f.properties?.RA || "").trim()) ||
    candidates.sort(
      (a, b) =>
        b.geometry.coordinates[0].length - a.geometry.coordinates[0].length,
    )[0];
  const rings =
    parcel.geometry.type === "MultiPolygon"
      ? parcel.geometry.coordinates.flat()
      : parcel.geometry.coordinates;
  const centre = rings.map(ringCentroid).sort((a, b) => b.area - a.area)[0];
  return { lat: centre.lat, lon: centre.lon };
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const version = ++requestVersion;
  const parts = parse(input.value);
  result.hidden = true;
  error.textContent = "";
  if (!parts) {
    error.textContent = "Enter an Alberta LSD like 1-10-56-12W4. Check each number and use W4, W5 or W6.";
    return;
  }
  button.disabled = true;
  button.textContent = "Finding…";
  try {
    const { lat, lon } = await locate(parts);
    if (version !== requestVersion) return;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error("No valid location was returned.");
    const legal = canonical(parts);
    const coords = `${lat.toFixed(6)},${lon.toFixed(6)}`;
    input.value = legal;
    $("#legalOut").textContent = legal;
    $("#google").href = "https://www.google.com/maps/search/?api=1&query=" + coords;
    $("#apple").href = "https://maps.apple.com/?q=" + encodeURIComponent(legal) + "&ll=" + coords;
    result.hidden = false;
    recentEntries = [legal, ...recentEntries.filter((entry) => entry !== legal)].slice(0, 30);
    saveHistory();
  } catch (err) {
    if (version === requestVersion) error.textContent = err instanceof TypeError || err.name === "TimeoutError"
      ? "Could not reach Alberta’s lookup service. Check your connection and try again."
      : err.message || "Could not find that location. Try again.";
  } finally {
    if (version === requestVersion) {
      button.disabled = false;
      button.textContent = "Find on maps";
    }
  }
});
