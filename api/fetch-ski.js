// api/fetch-ski.js
// Vercel serverless function — GET /api/fetch-ski.
//
// v2: consolidated all 7 resort queries into ONE Overpass request instead of
// 7 sequential ones. The old version measured 56 seconds under concurrent
// load (with mtb/hiking also hitting Overpass at once) — dangerously close
// to Vercel's 60s cap. One combined query removes 7x network round-trip
// overhead and the inter-resort delays entirely. Overlapping bboxes
// (A-Basin/Keystone are close together) are resolved by assigning each way
// to whichever resort bbox contains its first point.

const DIFF_MAP = {
  novice: 1, easy: 1, intermediate: 2, advanced: 3, expert: 4, freeride: 5, extreme: 5
};
const GONDOLA_TYPES = new Set(['gondola', 'mixed_lift', 'cable_car']);

const RESORTS = [
  { name: 'Arapahoe Basin', lat: 39.6425, lon: -105.8719 },
  { name: 'Keystone',       lat: 39.6046, lon: -105.9439 },
  { name: 'Loveland',       lat: 39.6803, lon: -105.8981 },
  { name: 'Copper Mountain',lat: 39.5019, lon: -106.1509 },
  { name: 'Breckenridge',   lat: 39.4817, lon: -106.0384 },
  { name: 'Eldora',         lat: 39.9375, lon: -105.5828 },
  { name: 'Ski Cooper',     lat: 39.3628, lon: -106.3097 }
];

const LAT_PAD = 0.025, LON_PAD = 0.035;
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];

function bboxFor(r) {
  return `${r.lat - LAT_PAD},${r.lon - LON_PAD},${r.lat + LAT_PAD},${r.lon + LON_PAD}`;
}

function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
  const h = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function wayLengthMeters(geometry) {
  let total = 0;
  for (let i = 1; i < geometry.length; i++) total += haversineMeters(geometry[i - 1], geometry[i]);
  return total;
}

async function overpassRequest(query) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) { // fewer retries than local script — time budget
    const endpoint = OVERPASS_ENDPOINTS[attempt % OVERPASS_ENDPOINTS.length];
    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
          'User-Agent': 'pushpin-denver-test/0.1 (personal trip-planner prototype)'
        },
        body: 'data=' + encodeURIComponent(query)
      });
      if (!resp.ok) throw new Error(`${resp.status} from ${endpoint}`);
      return await resp.json();
    } catch (e) {
      lastErr = e;
      await new Promise(res => setTimeout(res, 2000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

// (old per-resort fetchResort() removed — replaced by fetchAllResorts()
// below, which combines all 7 into a single Overpass request.)

async function fetchAllResorts() {
  const bboxStr = r => bboxFor(r);
  // ONE query covering all 7 resorts' bboxes, instead of 7 separate HTTP
  // round-trips with delays between them. Same total data, way less overhead,
  // and gentler on Overpass than 7 distinct connections.
  const clauses = RESORTS.map(r => `
      way["piste:type"="downhill"](${bboxStr(r)});
      way["aerialway"](${bboxStr(r)});
  `).join('\n');
  const query = `
    [out:json][timeout:50];
    (
      ${clauses}
    );
    out geom;
  `;
  const data = await overpassRequest(query);
  const elements = data.elements || [];

  // A way can fall inside more than one resort's bbox only if those boxes
  // overlap (the known A-Basin/Keystone case). Assign each way to whichever
  // resort bbox contains its FIRST point — same effective grouping as
  // separate per-resort queries produced, just computed client-side now.
  function resortForPoint(pt) {
    for (const r of RESORTS) {
      const latMin = r.lat - LAT_PAD, latMax = r.lat + LAT_PAD;
      const lonMin = r.lon - LON_PAD, lonMax = r.lon + LON_PAD;
      if (pt.lat >= latMin && pt.lat <= latMax && pt.lon >= lonMin && pt.lon <= lonMax) return r.name;
    }
    return null;
  }

  const byResort = {};
  RESORTS.forEach(r => { byResort[r.name] = { weightedDiffSum: 0, diffWeightTotal: 0, liftCount: 0, gondolaCount: 0 }; });

  for (const el of elements) {
    if (el.type !== 'way' || !el.tags || !el.geometry || el.geometry.length === 0) continue;
    const resortName = resortForPoint(el.geometry[0]);
    if (!resortName) continue;
    const bucket = byResort[resortName];

    if (el.tags['piste:type'] === 'downhill') {
      const len = wayLengthMeters(el.geometry);
      const diffVal = DIFF_MAP[(el.tags['piste:difficulty'] || '').toLowerCase()];
      if (diffVal && len > 0) { bucket.weightedDiffSum += diffVal * len; bucket.diffWeightTotal += len; }
    }
    if (el.tags.aerialway) {
      bucket.liftCount++;
      if (GONDOLA_TYPES.has(el.tags.aerialway)) bucket.gondolaCount++;
    }
  }

  return RESORTS.map(r => {
    const b = byResort[r.name];
    return {
      name: r.name, lat: r.lat, lon: r.lon,
      difficultyAvg: b.diffWeightTotal > 0 ? Math.round((b.weightedDiffSum / b.diffWeightTotal) * 100) / 100 : null,
      liftCount: b.liftCount, gondolaCount: b.gondolaCount, vertical: null
    };
  });
}

function assignSizeTiers(resorts) {
  const withLifts = resorts.filter(r => r.liftCount > 0);
  const sorted = [...withLifts].sort((a, b) => a.liftCount - b.liftCount);
  const third = Math.ceil(sorted.length / 3);
  const tierOf = name => {
    const idx = sorted.findIndex(r => r.name === name);
    if (idx === -1) return 'Unknown';
    if (idx < third) return 'Small';
    if (idx < third * 2) return 'Medium';
    return 'Big';
  };
  return resorts.map(r => ({ ...r, sizeTier: tierOf(r.name) }));
}

module.exports = async (req, res) => {
  try {
    const results = await fetchAllResorts();
    const tiered = assignSizeTiers(results);
    res.status(200).json({
      generatedAt: new Date().toISOString(),
      resorts: tiered,
      failures: [] // single-query version fails all-or-nothing rather than per-resort
    });
  } catch (e) {
    res.status(502).json({ error: 'Overpass request failed', detail: e.message, resorts: [], failures: RESORTS.map(r => ({ name: r.name, error: 'batch query failed' })) });
  }
};
