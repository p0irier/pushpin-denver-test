// api/fetch-ski-supplement.js
// Vercel serverless function — GET /api/fetch-ski-supplement?region=denver|norway|amsterdam
//
// The SLOW layer, called after fetch-ski.js's fast Places call. Uses
// Overpass (landuse=winter_sports areas, same discovery logic proven in
// ski v3) to find resorts Places' ski_resort category misses entirely —
// confirmed case: Loveland, CO. Frontend merges these in by proximity,
// deduping against what Places already found rather than showing
// duplicates. No rating (OSM has none) — that's the honest tradeoff for
// catching what the fast layer misses.

const DIFF_MAP = { novice: 1, easy: 1, intermediate: 2, advanced: 3, expert: 4, freeride: 5, extreme: 5 };
const GONDOLA_TYPES = new Set(['gondola', 'mixed_lift', 'cable_car']);
const BOUNDARY_PAD_DEG = 0.01;

const REGIONS = {
  denver: { south: 39.30, west: -106.40, north: 39.95, east: -105.00 },
  norway: { south: 62.30, west: 9.20, north: 63.70, east: 11.60 },
  amsterdam: { south: 52.0426, west: 4.2041, north: 52.6926, east: 5.6041 }
};

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
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

async function discoverResortAreas(bbox) {
  const bboxStr = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
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
      name: a.name, lat: a.lat, lng: a.lon,
      difficultyAvg: b.diffWeightTotal > 0 ? Math.round((b.weightedDiffSum / b.diffWeightTotal) * 100) / 100 : null,
      liftCount: b.liftCount, gondolaCount: b.gondolaCount,
      rating: null, ratingCount: 0, address: null, website: null,
      source: 'overpass'
    };
  }).filter(r => r.liftCount > 0);
}

module.exports = async (req, res) => {
  const regionKey = (req.query && req.query.region) || 'denver';
  const bbox = REGIONS[regionKey] || REGIONS.denver;
  try {
    const areas = await discoverResortAreas(bbox);
    const results = await fetchStatsForAreas(areas);
    res.status(200).json({
      generatedAt: new Date().toISOString(),
      region: regionKey,
      resorts: results
    });
  } catch (e) {
    res.status(502).json({ error: 'Overpass request failed', detail: e.message, resorts: [] });
  }
};
