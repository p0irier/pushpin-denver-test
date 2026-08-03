// api/fetch-ski.js
// Vercel serverless function — GET /api/fetch-ski.
//
// HONEST CAVEAT: the local script queried 7 resorts ONE AT A TIME with 4s
// gaps and up to 15s retry backoff each, specifically to be gentle with
// Overpass's shared public instance. That pattern doesn't fit comfortably
// inside a serverless function's time budget (60s max on Vercel Hobby).
// Delays here are shortened to try to fit — but if several resorts need
// retries in the same run, this can still time out. If that happens
// consistently, the real fix is querying resorts in parallel (rougher on
// Overpass, higher 429 risk) or splitting into multiple smaller functions —
// not attempted yet, flagging as a known limitation of this endpoint.

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

async function fetchResort(resort) {
  const bboxStr = bboxFor(resort);
  const query = `
    [out:json][timeout:25];
    (
      way["piste:type"="downhill"](${bboxStr});
      way["aerialway"](${bboxStr});
    );
    out geom;
  `;
  const data = await overpassRequest(query);
  let weightedDiffSum = 0, diffWeightTotal = 0, liftCount = 0, gondolaCount = 0;
  for (const el of data.elements || []) {
    if (el.type !== 'way' || !el.tags) continue;
    if (el.tags['piste:type'] === 'downhill' && el.geometry) {
      const len = wayLengthMeters(el.geometry);
      const diffVal = DIFF_MAP[(el.tags['piste:difficulty'] || '').toLowerCase()];
      if (diffVal && len > 0) { weightedDiffSum += diffVal * len; diffWeightTotal += len; }
    }
    if (el.tags.aerialway) {
      liftCount++;
      if (GONDOLA_TYPES.has(el.tags.aerialway)) gondolaCount++;
    }
  }
  return {
    name: resort.name, lat: resort.lat, lon: resort.lon,
    difficultyAvg: diffWeightTotal > 0 ? Math.round((weightedDiffSum / diffWeightTotal) * 100) / 100 : null,
    liftCount, gondolaCount, vertical: null
  };
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
  const results = [];
  const failures = [];
  for (const resort of RESORTS) {
    try {
      results.push(await fetchResort(resort));
    } catch (e) {
      failures.push({ name: resort.name, error: e.message });
    }
    await new Promise(r => setTimeout(r, 800)); // shortened from 4s local delay
  }
  const tiered = assignSizeTiers(results);
  res.status(200).json({
    generatedAt: new Date().toISOString(),
    resorts: tiered,
    failures // empty array if all 7 succeeded — surfaced so the UI can show partial-result state
  });
};
