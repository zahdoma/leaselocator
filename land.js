// DOM-free parsing and survey lookup logic, shared with the test suite.
export const PART_LIMITS = [16, 36, 127, 36, 6];
export const PART_WIDTHS = [2, 2, 3, 2, 1];
export const SOURCES = {
  alberta: {
    name: "Alberta ATS v4.1", region: "Alberta",
    url: "https://geospatial.alberta.ca/titan/rest/services/base/alberta_township_system/MapServer/20",
    fields: ["LS", "SEC", "TWP", "RGE", "M"],
  },
  saskatchewan: {
    name: "SaskGrid 2020 · TSASK", region: "Saskatchewan",
    url: "https://geis.tsask.ca/arcgis/rest/services/GEIS/MapServer/0",
    fields: ["LSD", "PSECT", "PTWP", "PRGE", "PMER"],
  },
};

export function parseDescription(value) {
  const match = value.trim().match(/^(\d{1,2})[- /]+(\d{1,2})[- /]+(\d{1,3})[- /]+(\d{1,2})[- /]*w\s*([1-6])(?:m)?$/i);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every((number, index) => number >= 1 && number <= PART_LIMITS[index]) ? parts : null;
}

export function formatDescription(parts) {
  return `${parts.slice(0, 4).join("-")}W${parts[4]}`;
}

export function parsePastedDescription(value) {
  const formatted = parseDescription(value);
  if (formatted) return formatted;
  const match = value.trim().match(/^(\d{2})(\d{2})(\d{2,3})(\d{2})([1-6])$/);
  return match ? parseDescription(`${match[1]}-${match[2]}-${match[3]}-${match[4]}W${match[5]}`) : null;
}

export function sourceFor(parts) {
  return parts[4] <= 3 ? SOURCES.saskatchewan : SOURCES.alberta;
}

export function queryURL(parts) {
  if (!parseDescription(formatDescription(parts))) throw new Error("Invalid land description.");
  const source = sourceFor(parts);
  const where = source.fields.map((field, index) => {
    if (source === SOURCES.alberta) return `${field}=${parts[index]}`;
    // SaskGrid stores numeric parts as text with inconsistent zero padding.
    const variants = [...new Set([1, 2, 3].map(width => String(parts[index]).padStart(width, "0")))];
    return `${field} IN (${variants.map(value => `'${value}'`).join(",")})`;
  }).join(" AND ");
  return `${source.url}/query?${new URLSearchParams({
    where, outFields: source === SOURCES.alberta ? "RA" : "FEATURECD",
    returnGeometry: "true", outSR: "4326", f: "json",
  })}`;
}

export function polygonCentre(rings) {
  const origin = rings?.[0]?.[0];
  if (!origin) throw new Error("Parcel geometry is missing.");
  let area = 0, weightedX = 0, weightedY = 0;
  for (const ring of rings) {
    if (ring.length < 3 || ring.some(point => point.length < 2 ||
      !Number.isFinite(point[0]) || !Number.isFinite(point[1]) ||
      point[0] < -121 || point[0] > -97 || point[1] < 48 || point[1] > 61)) {
      throw new Error("The survey service returned invalid parcel geometry.");
    }
    // Translate to avoid cancellation on small parcels. ArcGIS ring orientation
    // makes holes subtract and multipart parcels add to the weighted centre.
    for (let index = 0; index < ring.length; index++) {
      const a = ring[index], b = ring[(index + 1) % ring.length];
      const ax = a[0] - origin[0], ay = a[1] - origin[1];
      const bx = b[0] - origin[0], by = b[1] - origin[1];
      const cross = ax * by - bx * ay;
      area += cross;
      weightedX += (ax + bx) * cross;
      weightedY += (ay + by) * cross;
    }
  }
  if (Math.abs(area) < 1e-14) throw new Error("Parcel geometry has no usable area.");
  return { lon: origin[0] + weightedX / (3 * area), lat: origin[1] + weightedY / (3 * area) };
}

export function decodeParcel(data, source) {
  if (data.error) throw new Error(`${source.region}’s survey service could not complete the lookup. Try again later.`);
  if (!Array.isArray(data.features)) throw new Error("The survey service returned an unreadable response.");
  const parcels = data.features.filter(feature => feature.geometry &&
    (source !== SOURCES.alberta || feature.attributes?.RA?.trim() === ""));
  if (!parcels.length) throw new Error(`No parcel found in ${source.region}. Check each number. Coverage is limited to Alberta and Saskatchewan.`);
  if (parcels.length !== 1 || data.exceededTransferLimit) throw new Error("This description returned multiple parcels. Confirm it with the survey source.");
  return {
    ...polygonCentre(parcels[0].geometry.rings), source,
    theoretical: parcels[0].attributes?.FEATURECD === "THEORETIC",
  };
}

export async function locate(parts, signal) {
  const source = sourceFor(parts);
  const response = await fetch(queryURL(parts), { signal });
  if (!response.ok) throw new Error(`${source.region}’s survey service is unavailable. Try again later.`);
  return decodeParcel(await response.json(), source);
}
