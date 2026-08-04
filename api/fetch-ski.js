// api/fetch-ski.js
// Vercel serverless function — GET /api/fetch-ski?region=denver|norway|amsterdam
//
// v4 — HYBRID: Google Places for discovery, Overpass for structured stats.
//
// Why: v3's pure-OSM discovery (landuse=winter_sports areas) missed resorts
// mapped as multipolygon relations, surfaced backcountry-only areas as false
// positives (needed a zero-lift filter patch), and had no rating signal at
// all. Pure Google Places has the opposite problem: great discovery (real
// `ski_resort` type, ratings), but zero structured data — no difficulty, no
// lift count, nothing Overpass actually measures.
//
// This version uses each system for what it's actually good at:
//   Step 1: Google Places Text Search (includedType: ski_resort) finds
//           candidates — real names, locations, ratings. This IS the
//           resort list now, and it's a genuinely reliable "does this
//           place exist and is it real" source, unlike OSM boundary tags.
//   Step 2: build a SMALL bbox around each candidate's known-good point
//           (not a blind citywide guess), then run ONE combined Overpass
//           query across all those small boxes for real piste/lift data.
//           This is an easier question for Overpass to answer than "find
//           and cluster everything" — we already know where to look.
//
// Bonus: resorts now carry a real Google rating alongside difficulty/lifts,
// which v3 never had.
//
// Known limitation: matching is by proximity (Places point falls in a small
// box), not by name — a resort with genuinely sparse/missing OSM data near
// its Places location will show 0 lifts and get filtered out, same as
// before. Open-data coverage gaps are real; this doesn't erase them.

const DIFF_MAP = {
  novice: 1, easy: 1, intermediate: 2, advanced: 3, expert: 4, freeride: 5, extreme: 5
};
const GONDOLA_TYPES = new Set(['gondola', 'mixed_lift', 'cable_car']);

const REGIONS = {
  denver: { south: 39.30, west: -106.40, north: 39.95, east: -105.00 },
  norway: { south: 62.30, west: 9.20, north: 63.70, east: 11.60 },
  amsterdam: { south: 52.0426, west: 4.2041, north: 52.6926, east: 5.6041 }
};

// Small box around each Google Places candidate point — same scale as the
// original hand-picked Denver resort boxes, tight enough to avoid pulling in
// a neighboring resort's data (the known A-Basin/Keystone overlap risk).
const CANDIDATE_LAT_PAD = 0.03;
const CANDIDATE_LON_PAD = 0.04;

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

// Step 1: discover candidates via Google Places.
async function discoverResortCandidates(bbox) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    throw new Error('GOOGLE_PLACES_API_KEY environment variable is not set in Vercel project settings');
  }

  const body = {
    textQuery: 'ski resort',
    includedType: 'ski_resort',
    maxResultCount: 20,
    locationRestriction: {
      rectangle: {
        low: { latitude: bbox.south, longitude: bbox.west },
        high: { latitude: bbox.north, longitude: bbox.east }
      }
    }
  };

  const resp = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': [
        'places.displayName',
        'places.location',
        'places.rating',
        'places.userRatingCount',
        'places.businessStatus'
      ].join(',')
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Google Places returned ${resp.status}: ${errText.slice(0, 300)}`);
  }
  const data = await resp.json();
  return (data.places || [])
    .filter(p => p.location && (p.businessStatus || 'OPERATIONAL') === 'OPERATIONAL')
    .map(p => ({
      name: p.displayName ? p.displayName.text : 'Unknown',
      lat: p.location.latitude,
      lon: p.location.longitude,
      rating: typeof p.rating === 'number' ? p.rating : null,
      ratingCount: typeof p.userRatingCount === 'number' ? p.userRatingCount : 0,
      south: p.location.latitude - CANDIDATE_LAT_PAD,
      north: p.location.latitude + CANDIDATE_LAT_PAD,
      west: p.location.longitude - CANDIDATE_LON_PAD,
      east: p.location.longitude + CANDIDATE_LON_PAD
    }));
}

// Step 2: pull piste/lift data for all candidates in one combined Overpass query.
async function fetchStatsForCandidates(candidates) {
  if (candidates.length === 0) return [];

  const clauses = candidates.map(c => `
      way["piste:type"="downhill"](${c.south},${c.west},${c.north},${c.east});
      way["aerialway"](${c.south},${c.west},${c.north},${c.east});
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

  function candidateForPoint(pt) {
    for (const c of candidates) {
      if (pt.lat >= c.south && pt.lat <= c.north && pt.lon >= c.west && pt.lon <= c.east) return c.name;
    }
    return null;
  }

  const byName = {};
  candidates.forEach(c => { byName[c.name] = { weightedDiffSum: 0, diffWeightTotal: 0, liftCount: 0, gondolaCount: 0 }; });

  for (const el of elements) {
    if (el.type !== 'way' || !el.tags || !el.geometry || el.geometry.length === 0) continue;
    const name = candidateForPoint(el.geometry[0]);
    if (!name) continue;
    const bucket = byName[name];

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

  return candidates.map(c => {
    const b = byName[c.name];
    return {
      name: c.name, lat: c.lat, lon: c.lon,
      rating: c.rating, ratingCount: c.ratingCount,
      difficultyAvg: b.diffWeightTotal > 0 ? Math.round((b.weightedDiffSum / b.diffWeightTotal) * 100) / 100 : null,
      liftCount: b.liftCount, gondolaCount: b.gondolaCount, vertical: null
    };
  }).filter(r => r.liftCount > 0); // drop candidates with no lift infrastructure found nearby
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
  const bbox = REGIONS[regionKey] || REGIONS.denver;
  try {
    const candidates = await discoverResortCandidates(bbox);
    const results = await fetchStatsForCandidates(candidates);
    const tiered = assignSizeTiers(results);
    res.status(200).json({
      generatedAt: new Date().toISOString(),
      region: regionKey,
      candidatesFromPlaces: candidates.length,
      droppedNoLiftsFound: candidates.length - results.length,
      resorts: tiered,
      failures: []
    });
  } catch (e) {
    res.status(502).json({ error: 'Request failed', detail: e.message, resorts: [], failures: [] });
  }
};
