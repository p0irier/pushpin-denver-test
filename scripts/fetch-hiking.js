// fetch-hiking.js
// Run locally: node scripts/fetch-hiking.js
//
// v3 — back to querying named path/footway/track WAYS (broader coverage than
// v2's route relations, which only returned 16 for Denver-metro — too sparse).
// But instead of rendering every segment as a polyline (v1's problem: 1,229
// segments, way too cluttered), this version GROUPS segments by name and
// collapses each trail down to ONE point on the map + one card.
//
// Distance is still summed across all of a trail's segments (so the stat is
// accurate), but the map only gets a single representative pin per trail —
// per current direction: "just use name and put that pin in the map, I don't
// need the trail route."
//
// Still named-only, still a length filter, sac_scale still enrichment-only.

const fs = require('fs');
const path = require('path');

const HIKING_BBOX = { south: 39.55, west: -105.35, north: 39.85, east: -105.05 };
const MIN_TRAIL_MILES = 3;

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
  const query = `
    [out:json][timeout:60];
    (
      way["highway"="path"]["name"](${bboxStr});
      way["highway"="footway"]["name"](${bboxStr});
      way["highway"="track"]["name"]["foot"!="no"](${bboxStr});
    );
    out geom;
  `;
  const data = await overpassRequest(query, 'Denver hiking ways bbox');

  // Group raw segments by name.
  const byName = {};
  for (const el of data.elements || []) {
    if (el.type !== 'way' || !el.tags || !el.tags.name || !el.geometry || el.geometry.length < 2) continue;
    const name = el.tags.name;
    if (!byName[name]) byName[name] = { segments: [], sacScale: null };
    byName[name].segments.push(el.geometry);
    if (!byName[name].sacScale && el.tags.sac_scale && SAC_SCALE_LABELS[el.tags.sac_scale]) {
      byName[name].sacScale = SAC_SCALE_LABELS[el.tags.sac_scale];
    }
  }

  const trails = [];
  for (const [name, group] of Object.entries(byName)) {
    const totalMiles = Math.round(
      group.segments.reduce((sum, seg) => sum + segmentLengthMiles(seg), 0) * 100
    ) / 100;
    if (totalMiles < MIN_TRAIL_MILES) continue;

    // Representative point: first point of the first (typically longest-ish,
    // but really just first-encountered) segment. Good enough for a pin.
    const point = group.segments[0][0];

    trails.push({
      name,
      lat: point.lat,
      lon: point.lon,
      distanceMiles: totalMiles,
      sacScale: group.sacScale,
      segmentCount: group.segments.length,
      description: group.sacScale
        ? `Hiking trail, ${group.sacScale}, ${totalMiles} mi total`
        : `Hiking trail, ${totalMiles} mi total`
    });
  }
  return trails;
}

async function main() {
  console.log('Fetching named hiking ways from Overpass, grouping by name into single pins...');
  const trails = await fetchTrails();
  console.log(`Got ${trails.length} unique named trails (min length ${MIN_TRAIL_MILES} mi total).`);
  const withSac = trails.filter(t => t.sacScale).length;
  console.log(`  ${withSac} of ${trails.length} have a sac_scale tag.`);

  const output = { generatedAt: new Date().toISOString(), bbox: HIKING_BBOX, minTrailMiles: MIN_TRAIL_MILES, trails };
  const outPath = path.join(__dirname, '..', 'public', 'data', 'hiking-denver.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Wrote ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
