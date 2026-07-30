// fetch-mtb.js
// Run locally: node scripts/fetch-mtb.js
// Queries public Overpass API for ways tagged mtb:scale or mtb:scale:imba
// inside a Denver-metro/foothills bounding box. Writes public/data/mtb-denver.json.
//
// v1 simplification: each tagged OSM way becomes its own trail entry. A
// single named trail split across multiple OSM ways (same issue we hit with
// ski runs) will show as separate segments until we add route-relation
// grouping. Noted here so it's not a surprise later.
//
// Per current direction: mtb:scale:uphill is NOT used in this pass.

const fs = require('fs');
const path = require('path');

// Denver metro + foothills — covers Golden/Lakewood/Morrison trail systems
// (Green Mountain, Apex, White Ranch, Centennial Cone, Buffalo Creek area).
const MTB_BBOX = { south: 39.55, west: -105.35, north: 39.85, east: -105.05 };

// mtb:scale is 0-6 numeric. mtb:scale:imba is the standard 0-4 diamond scale.
// Where imba isn't tagged, bucket the numeric scale down into it.
const SCALE_TO_IMBA_BUCKET = { 0: 0, 1: 1, 2: 2, 3: 3, 4: 3, 5: 4, 6: 4 };

const IMBA_LABELS = {
  0: 'Easiest (White)',
  1: 'Easy (Green)',
  2: 'Intermediate (Blue)',
  3: 'Advanced (Black)',
  4: 'Expert (Double Black)'
};

function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
  const h = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function wayLengthMiles(geometry) {
  let meters = 0;
  for (let i = 1; i < geometry.length; i++) {
    meters += haversineMeters(geometry[i - 1], geometry[i]);
  }
  return meters / 1609.34;
}

function resolveImba(tags) {
  if (tags['mtb:scale:imba'] !== undefined) {
    const v = parseInt(tags['mtb:scale:imba'], 10);
    if (!isNaN(v) && v >= 0 && v <= 4) return v;
  }
  if (tags['mtb:scale'] !== undefined) {
    const raw = tags['mtb:scale'].toString().split('-')[0]; // handle ranges like "2-3"
    const v = parseInt(raw, 10);
    if (!isNaN(v) && SCALE_TO_IMBA_BUCKET[v] !== undefined) return SCALE_TO_IMBA_BUCKET[v];
  }
  return null;
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
      const waitMs = 5000 * (attempt + 1);
      console.log(`  attempt ${attempt + 1} failed for ${label} (${e.message}), retrying in ${waitMs/1000}s...`);
      await new Promise(res => setTimeout(res, waitMs));
    }
  }
  throw lastErr;
}

async function fetchTrails() {
  const bboxStr = `${MTB_BBOX.south},${MTB_BBOX.west},${MTB_BBOX.north},${MTB_BBOX.east}`;
  const query = `
    [out:json][timeout:60];
    (
      way["mtb:scale"](${bboxStr});
      way["mtb:scale:imba"](${bboxStr});
    );
    out geom;
  `;
  const data = await overpassRequest(query, 'Denver MTB bbox');

  const trails = [];
  for (const el of data.elements || []) {
    if (el.type !== 'way' || !el.tags || !el.geometry || el.geometry.length < 2) continue;
    const imba = resolveImba(el.tags);
    const distanceMiles = Math.round(wayLengthMiles(el.geometry) * 100) / 100;
    const name = el.tags.name || `Unnamed trail segment (way ${el.id})`;
    trails.push({
      id: el.id,
      name,
      difficultyImba: imba,
      difficultyLabel: imba !== null ? IMBA_LABELS[imba] : 'Unrated',
      distanceMiles,
      description: imba !== null
        ? `Singletrack, ${IMBA_LABELS[imba]}, ${distanceMiles} mi`
        : `Singletrack, difficulty unrated, ${distanceMiles} mi`,
      geometry: el.geometry.map(pt => ({ lat: pt.lat, lon: pt.lon }))
    });
  }
  return trails;
}

async function main() {
  console.log('Fetching MTB trails from Overpass for Denver metro/foothills bbox...');
  const trails = await fetchTrails();
  console.log(`Got ${trails.length} tagged trail segments.`);

  const output = { generatedAt: new Date().toISOString(), bbox: MTB_BBOX, trails };
  const outPath = path.join(__dirname, '..', 'public', 'data', 'mtb-denver.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Wrote ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
