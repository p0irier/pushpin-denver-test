// fetch-hiking.js
// Run locally: node scripts/fetch-hiking.js
//
// v2 — switched from raw named path/footway/track ways (1,229 results, way too
// noisy — mostly short fragments of the same trail split across many OSM ways)
// to named `route=hiking` RELATIONS instead.
//
// Why this is better, not just different:
// - A route relation only exists because someone deliberately assembled an
//   official, maintained trail route — so this is a real (if imperfect) proxy
//   for "this is a real hike," not just "this is a walkable path."
// - It also solves the segment-duplication problem as a side effect: all of a
//   relation's member ways are grouped under ONE trail entry (one card, one
//   name), with multiple line segments under the hood for the map.
// - Coverage is sparser than raw ways, though — not every real trail has been
//   assembled into a relation. This script logs the count so we can judge
//   whether that tradeoff is acceptable per-region.
//
// Also applies a minimum length filter (drop anything under MIN_TRAIL_MILES)
// to catch short/junk relations that aren't real hikes.
//
// sac_scale is still enrichment only, never a filter (see v1 notes) — most
// trails simply won't have it tagged, and that's normal.

const fs = require('fs');
const path = require('path');

const HIKING_BBOX = { south: 39.55, west: -105.35, north: 39.85, east: -105.05 };
const MIN_TRAIL_MILES = 0.3; // drop short/junk relations below this

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];

const SAC_SCALE_LABELS = {
  hiking: 'T1 · Hiking',
  mountain_hiking: 'T2 · Mountain hiking',
  demanding_mountain_hiking: 'T3 · Demanding mountain hiking',
  alpine_hiking: 'T4 · Alpine hiking',
  demanding_alpine_hiking: 'T5 · Demanding alpine hiking',
  difficult_alpine_hiking: 'T6 · Difficult alpine hiking'
};

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

function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
  const h = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function segmentLengthMiles(geometry) {
  let meters = 0;
  for (let i = 1; i < geometry.length; i++) {
    meters += haversineMeters(geometry[i - 1], geometry[i]);
  }
  return meters / 1609.34;
}

async function fetchTrails() {
  const bboxStr = `${HIKING_BBOX.south},${HIKING_BBOX.west},${HIKING_BBOX.north},${HIKING_BBOX.east}`;
  // Fetch the relations themselves, then recurse (">;") to pull in their
  // member ways/nodes, then output geometry for everything.
  const query = `
    [out:json][timeout:90];
    (
      relation["route"="hiking"]["name"](${bboxStr});
    );
    out body;
    >;
    out geom;
  `;
  const data = await overpassRequest(query, 'Denver hiking relations bbox');
  const elements = data.elements || [];

  // Index all ways by id so relation members can look up their geometry.
  const wayById = {};
  for (const el of elements) {
    if (el.type === 'way' && el.geometry) wayById[el.id] = el;
  }

  const trails = [];
  for (const el of elements) {
    if (el.type !== 'relation' || !el.tags || !el.tags.name) continue;

    const segments = [];
    for (const member of el.members || []) {
      if (member.type !== 'way') continue;
      const way = wayById[member.ref];
      if (way && way.geometry && way.geometry.length >= 2) {
        segments.push(way.geometry.map(pt => ({ lat: pt.lat, lon: pt.lon })));
      }
    }
    if (segments.length === 0) continue; // relation had no usable geometry

    const totalMiles = Math.round(
      segments.reduce((sum, seg) => sum + segmentLengthMiles(seg), 0) * 100
    ) / 100;

    if (totalMiles < MIN_TRAIL_MILES) continue; // length filter

    const sacKey = el.tags.sac_scale;
    const sacLabel = sacKey && SAC_SCALE_LABELS[sacKey] ? SAC_SCALE_LABELS[sacKey] : null;

    trails.push({
      id: el.id,
      name: el.tags.name,
      distanceMiles: totalMiles,
      sacScale: sacLabel,
      segmentCount: segments.length,
      description: sacLabel
        ? `Hiking trail, ${sacLabel}, ${totalMiles} mi`
        : `Hiking trail, ${totalMiles} mi`,
      geometry: segments // array of segments, each an array of {lat,lon} points
    });
  }
  return trails;
}

async function main() {
  console.log('Fetching named hiking ROUTE RELATIONS from Overpass for Denver metro/foothills bbox...');
  const trails = await fetchTrails();
  console.log(`Got ${trails.length} named trail relations (min length ${MIN_TRAIL_MILES} mi).`);
  const withSac = trails.filter(t => t.sacScale).length;
  console.log(`  ${withSac} of ${trails.length} have a sac_scale tag.`);
  if (trails.length < 15) {
    console.log('  Note: low count likely means relation coverage is sparse for this region — worth deciding if that tradeoff is acceptable or if raw-way fallback is needed.');
  }

  const output = { generatedAt: new Date().toISOString(), bbox: HIKING_BBOX, minTrailMiles: MIN_TRAIL_MILES, trails };
  const outPath = path.join(__dirname, '..', 'public', 'data', 'hiking-denver.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Wrote ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
