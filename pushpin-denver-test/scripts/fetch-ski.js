// fetch-ski.js
// Run locally: node scripts/fetch-ski.js
// Queries public Overpass API for each Denver-area resort in its OWN small
// bounding box (not one big box) to avoid the A-Basin/Keystone bleed problem
// we already hit once. Writes public/data/ski-denver.json.
//
// Requires Node 18+ (for global fetch). Check with: node -v

const fs = require('fs');
const path = require('path');

// Difficulty weighting, same scale used previously: 1 = easiest, 5 = hardest.
// Only piste:type=downhill ways count. Nordic/hike/skitour are excluded by
// the query itself (we only ask for piste:type=downhill).
const DIFF_MAP = {
  novice: 1, easy: 1,
  intermediate: 2,
  advanced: 3,
  expert: 4,
  freeride: 5, extreme: 5
};

// Lift types that count as "aerial cabin" style lifts vs standard chair/surface.
const GONDOLA_TYPES = new Set(['gondola', 'mixed_lift', 'cable_car']);

// Denver-region resorts, individually boxed. Pad is intentionally tight
// (~3km half-width) to keep A-Basin and Keystone from contaminating each
// other — they're only 5.6mi apart.
const RESORTS = [
  { name: 'Arapahoe Basin', lat: 39.6425, lon: -105.8719 },
  { name: 'Keystone',       lat: 39.6046, lon: -105.9439 },
  { name: 'Loveland',       lat: 39.6803, lon: -105.8981 },
  { name: 'Copper Mountain',lat: 39.5019, lon: -106.1509 },
  { name: 'Breckenridge',   lat: 39.4817, lon: -106.0384 },
  { name: 'Eldora',         lat: 39.9375, lon: -105.5828 },
  { name: 'Ski Cooper',     lat: 39.3628, lon: -106.3097 }
];

const LAT_PAD = 0.025; // ~2.8km
const LON_PAD = 0.035; // ~3km at this latitude

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
  for (let i = 1; i < geometry.length; i++) {
    total += haversineMeters(geometry[i - 1], geometry[i]);
  }
  return total;
}

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];

async function overpassRequest(query, label) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
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
      const waitMs = 5000 * (attempt + 1); // 5s, 10s, 15s
      console.log(`    attempt ${attempt + 1} failed for ${label} (${e.message}), retrying in ${waitMs/1000}s...`);
      await new Promise(res => setTimeout(res, waitMs));
    }
  }
  throw lastErr;
}

async function fetchResort(resort) {
  const bboxStr = bboxFor(resort);
  const query = `
    [out:json][timeout:60];
    (
      way["piste:type"="downhill"](${bboxStr});
      way["aerialway"](${bboxStr});
    );
    out geom;
  `;
  const data = await overpassRequest(query, resort.name);

  let weightedDiffSum = 0, diffWeightTotal = 0;
  let liftCount = 0, gondolaCount = 0;

  for (const el of data.elements || []) {
    if (el.type !== 'way' || !el.tags) continue;

    if (el.tags['piste:type'] === 'downhill' && el.geometry) {
      const len = wayLengthMeters(el.geometry);
      const diffKey = (el.tags['piste:difficulty'] || '').toLowerCase();
      const diffVal = DIFF_MAP[diffKey];
      if (diffVal && len > 0) {
        weightedDiffSum += diffVal * len;
        diffWeightTotal += len;
      }
    }

    if (el.tags.aerialway) {
      liftCount++;
      if (GONDOLA_TYPES.has(el.tags.aerialway)) gondolaCount++;
    }
  }

  return {
    name: resort.name,
    lat: resort.lat,
    lon: resort.lon,
    difficultyAvg: diffWeightTotal > 0 ? Math.round((weightedDiffSum / diffWeightTotal) * 100) / 100 : null,
    liftCount,
    gondolaCount,
    vertical: null // known gap — needs OpenSkiMap ingestion, not wired in this test
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

async function main() {
  console.log(`Fetching ${RESORTS.length} resorts from Overpass (sequential, with delay to be polite to the shared public instance)...`);
  const results = [];
  for (const resort of RESORTS) {
    console.log(`  - ${resort.name}...`);
    try {
      const r = await fetchResort(resort);
      results.push(r);
      console.log(`    OK: ${r.liftCount} lifts, avg difficulty ${r.difficultyAvg}`);
    } catch (e) {
      console.error(`    FAILED: ${e.message}`);
    }
    await new Promise(res => setTimeout(res, 4000)); // be polite, avoid rate limit
  }

  const tiered = assignSizeTiers(results);
  const output = { generatedAt: new Date().toISOString(), resorts: tiered };

  const outPath = path.join(__dirname, '..', 'public', 'data', 'ski-denver.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\nWrote ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
