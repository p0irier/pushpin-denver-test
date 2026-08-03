// api/fetch-hiking.js
// Vercel serverless function. Runs on Vercel's servers (not the browser, not
// local Node) when the frontend calls GET /api/fetch-hiking.
//
// Same logic as scripts/fetch-hiking.js (named ways, grouped by name into one
// point per trail, length filter, sac_scale as enrichment) — just wrapped as
// an HTTP handler instead of a CLI script, and returning JSON directly to the
// browser instead of writing a file.
//
// No data is persisted/cached here yet — every click re-queries Overpass live.
// That's fine for manual testing. If this becomes the real per-trip pattern,
// add caching (Vercel KV/Blob) keyed by region before relying on it at scale.

const REGIONS = {
  denver: { south: 39.55, west: -105.35, north: 39.85, east: -105.05 },
  norway: { south: 62.30, west: 9.20, north: 63.70, east: 11.60 }
};
const MIN_TRAIL_MILES = 3;

// REVERTED: private.coffee as primary caused all three Overpass-based
// categories to time out at exactly 60s (Vercel's cap) in testing — strong
// signal it was down/hanging at that moment, not just slower. Back to
// overpass-api.de first (proven working tonight), private.coffee demoted to
// a fallback rather than trusted as primary without real uptime monitoring.
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];

const SAC_SCALE_LABELS = {
  hiking: 'T1 · Hiking',
  mountain_hiking: 'T2 · Mountain hiking',
  demanding_mountain_hiking: 'T3 · Demanding mountain hiking',
  alpine_hiking: 'T4 · Alpine hiking',
  demanding_alpine_hiking: 'T5 · Demanding alpine hiking',
  difficult_alpine_hiking: 'T6 · Difficult alpine hiking'
};

async function overpassRequest(query) {
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
      // Shorter backoff than the local script since we're inside a function
      // timeout budget here, not a patient CLI run.
      const waitMs = 2000 * (attempt + 1);
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

async function fetchTrails(bbox) {
  const bboxStr = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  const query = `
    [out:json][timeout:50];
    (
      way["highway"="path"]["name"](${bboxStr});
      way["highway"="footway"]["name"](${bboxStr});
      way["highway"="track"]["name"]["foot"!="no"](${bboxStr});
    );
    out geom;
  `;
  const data = await overpassRequest(query);

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

// Hiking is low-priority and has no quality signal (sac_scale too sparse to
// rank on) — per direction, only surface the top 10% by distance, on the
// theory that longer/more substantial trails are more likely to be worth
// showing than a long tail of short named paths.
function keepTop10PercentByDistance(trails) {
  if (trails.length === 0) return trails;
  const sorted = [...trails].sort((a, b) => b.distanceMiles - a.distanceMiles);
  const keepCount = Math.max(1, Math.ceil(sorted.length * 0.1));
  return sorted.slice(0, keepCount);
}

module.exports = async (req, res) => {
  const regionKey = (req.query && req.query.region) || 'denver';
  const bbox = REGIONS[regionKey] || REGIONS.denver;
  try {
    const allTrails = await fetchTrails(bbox);
    const trails = keepTop10PercentByDistance(allTrails);
    res.status(200).json({
      generatedAt: new Date().toISOString(),
      region: regionKey,
      bbox,
      minTrailMiles: MIN_TRAIL_MILES,
      totalFound: allTrails.length,
      trails
    });
  } catch (e) {
    res.status(502).json({ error: 'Overpass request failed', detail: e.message });
  }
};
