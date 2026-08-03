// api/fetch-ski.js
// Vercel serverless function — GET /api/fetch-ski?region=denver|norway
//
// v3 — REMOVED the hardcoded named resort list entirely. Resorts are now
// DISCOVERED from OSM data itself, the same way MTB/hiking already work:
//
// Step 1: query the region bbox for named landuse=winter_sports areas —
//         this is how OSM tags an actual ski area boundary. This IS the
//         resort list now, found live, not typed in by us.
// Step 2: for each discovered area, compute its own bounding box from its
//         boundary geometry, then run the same combined piste/lift query
//         as before — just against discovered boundaries instead of
//         hand-picked resort centers.
//
// Known limitation, stated honestly: this only catches resorts mapped as a
// single closed WAY with landuse=winter_sports + a name. Resorts mapped as
// multipolygon RELATIONS (common for larger/irregular resort shapes) are not
// handled yet — that would need relation member recursion, not implemented
// in this pass. If a region returns suspiciously few/zero resorts, this is
// the first thing to check.

const DIFF_MAP = {
  novice: 1, easy: 1, intermediate: 2, advanced: 3, expert: 4, freeride: 5, extreme: 5
};
const GONDOLA_TYPES = new Set(['gondola', 'mixed_lift', 'cable_car']);

// Same region bboxes used by the other categories — the broader "area of
// interest" a trip would cover, not a single resort's footprint.
const REGIONS = {
  denver: { south: 39.30, west: -106.40, north: 39.95, east: -105.00 },
  norway: { south: 62.30, west: 9.20, north: 63.70, east: 11.60 }
};

const BOUNDARY_PAD_DEG = 0.01; // small margin so lifts/pistes just outside the exact drawn boundary still get caught
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];

async function overpassRequest(query) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
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

// Step 1: discover named winter-sports areas within the region.
async function discoverResortAreas(regionBbox) {
  const bboxStr = `${regionBbox.south},${regionBbox.west},${regionBbox.north},${regionBbox.east}`;
  const query = `
    [out:json][timeout:40];
    (
      way["landuse"="winter_sports"]["name"](${bboxStr});
    );
    out geom;
  `;
  const data = await overpassRequest(query);
  const areas = [];
  for (const el of data.elements || []) {
    if (el.type !== 'way' || !el.tags || !el.tags.name || !el.geometry || el.geometry.length === 0) continue;
    const lats = el.geometry.map(p => p.lat);
    const lons = el.geometry.map(p => p.lon);
    areas.push({
      name: el.tags.name,
      south: Math.min(...lats) - BOUNDARY_PAD_DEG,
      north: Math.max(...lats) + BOUNDARY_PAD_DEG,
      west: Math.min(...lons) - BOUNDARY_PAD_DEG,
      east: Math.max(...lons) + BOUNDARY_PAD_DEG,
      lat: lats.reduce((a, b) => a + b, 0) / lats.length,
      lon: lons.reduce((a, b) => a + b, 0) / lons.length
    });
  }
  return areas;
}

// Step 2: pull piste/lift data for all discovered areas in one combined query.
async function fetchStatsForAreas(areas) {
  if (areas.length === 0) return [];

  const clauses = areas.map(a => `
      way["piste:type"="downhill"](${a.south},${a.west},${a.north},${a.east});
      way["aerialway"](${a.south},${a.west},${a.north},${a.east});
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

  function areaForPoint(pt) {
    for (const a of areas) {
      if (pt.lat >= a.south && pt.lat <= a.north && pt.lon >= a.west && pt.lon <= a.east) return a.name;
    }
    return null;
  }

  const byArea = {};
  areas.forEach(a => { byArea[a.name] = { weightedDiffSum: 0, diffWeightTotal: 0, liftCount: 0, gondolaCount: 0 }; });

  for (const el of elements) {
    if (el.type !== 'way' || !el.tags || !el.geometry || el.geometry.length === 0) continue;
    const areaName = areaForPoint(el.geometry[0]);
    if (!areaName) continue;
    const bucket = byArea[areaName];

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

  return areas.map(a => {
    const b = byArea[a.name];
    return {
      name: a.name, lat: a.lat, lon: a.lon,
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
  const regionKey = (req.query && req.query.region) || 'denver';
  const regionBbox = REGIONS[regionKey] || REGIONS.denver;
  try {
    const areas = await discoverResortAreas(regionBbox);
    const results = await fetchStatsForAreas(areas);
    const tiered = assignSizeTiers(results);
    res.status(200).json({
      generatedAt: new Date().toISOString(),
      region: regionKey,
      discoveredAreaCount: areas.length,
      resorts: tiered,
      failures: []
    });
  } catch (e) {
    res.status(502).json({ error: 'Overpass request failed', detail: e.message, resorts: [], failures: [] });
  }
};
