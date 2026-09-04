/**
 * OpenColor match API — Cloudflare Pages Function.
 *
 *   GET /api/match?L=<0..100>&a=<num>&b=<num>[&mode=per-system|pooled][&limit=N][&system=<id>]
 *
 * Returns the nearest named color standards to a CIELAB (D65/2°) input, ranked
 * by CIEDE2000. CORS-open so any browser or AI tool can call it.
 *
 *   per-system (default): the single best match in each system, ranked (limit
 *                         caps how many systems come back).
 *   pooled              : the top-N nearest overall.
 *   system=<id>         : restrict to one system (see /data/index.json for ids)
 *                         and return its top-N.
 *
 * Examples:
 *   /api/match?L=53.24&a=80.09&b=67.20
 *   /api/match?L=93.9&a=0.1&b=1.7&mode=pooled&limit=5
 *   /api/match?L=45&a=60&b=35&system=ral_classic&limit=10
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

export async function onRequest(context) {
  const { request } = context;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'GET') return json({ error: 'Use GET.' }, 405);

  const url = new URL(request.url);
  const q = url.searchParams;
  const L = Number(q.get('L'));
  const a = Number(q.get('a'));
  const b = Number(q.get('b'));
  if (![L, a, b].every(Number.isFinite)) {
    return json({ error: 'Provide numeric query params L (0–100), a and b. Example: /api/match?L=53.2&a=80.1&b=67.2' }, 400);
  }

  const mode = q.get('mode') === 'pooled' ? 'pooled' : 'per-system';
  const systemFilter = q.get('system') || null;
  const limit = clamp(parseInt(q.get('limit') || '', 10), 1, 50);

  // Load the flat dataset (edge-cached).
  const dataURL = new URL('/data/all.json', url.origin);
  const res = await fetch(dataURL, { cf: { cacheTtl: 86400, cacheEverything: true } });
  if (!res.ok) return json({ error: 'dataset unavailable' }, 502);
  const dataset = await res.json();

  const scan = { L, a, b };
  let pool = dataset.colors;
  if (systemFilter) pool = pool.filter((c) => c.systemId === systemFilter);
  if (pool.length === 0) return json({ error: `no colors for system "${systemFilter}"` }, 404);

  const scored = pool.map((c) => ({ c, dE: ciede2000(scan, c) }));

  let matches;
  if (systemFilter || mode === 'pooled') {
    scored.sort((x, y) => x.dE - y.dE);
    matches = scored.slice(0, limit ?? 10);
  } else {
    // best per system, ranked
    const best = new Map();
    for (const s of scored) {
      const cur = best.get(s.c.systemId);
      if (!cur || s.dE < cur.dE) best.set(s.c.systemId, s);
    }
    matches = [...best.values()].sort((x, y) => x.dE - y.dE);
    if (limit) matches = matches.slice(0, limit);
  }

  return json({
    query: { L, a, b },
    colorSpace: 'CIELAB D65/2°',
    deltaE: 'CIEDE2000',
    mode: systemFilter ? `system:${systemFilter}` : mode,
    count: matches.length,
    matches: matches.map(({ c, dE }) => ({
      system: c.system,
      systemId: c.systemId,
      code: c.code,
      name: c.name,
      hex: c.hex,
      L: c.L,
      a: c.a,
      b: c.b,
      deltaE: Math.round(dE * 100) / 100,
    })),
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300', ...CORS },
  });
}

function clamp(n, lo, hi) {
  if (!Number.isFinite(n)) return null;
  return Math.max(lo, Math.min(hi, n));
}

// --- CIEDE2000 (Sharma, Wu & Dalal 2005) ---
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
function ciede2000(p, q) {
  const C1 = Math.hypot(p.a, p.b), C2 = Math.hypot(q.a, q.b);
  const Cbar = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cbar ** 7 / (Cbar ** 7 + 25 ** 7)));
  const a1 = (1 + G) * p.a, a2 = (1 + G) * q.a;
  const C1p = Math.hypot(a1, p.b), C2p = Math.hypot(a2, q.b);
  const h1 = hue(p.b, a1), h2 = hue(q.b, a2);
  const dLp = q.L - p.L, dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    const diff = h2 - h1;
    dhp = Math.abs(diff) <= 180 ? diff : diff > 180 ? diff - 360 : diff + 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dhp) / 2);
  const Lbar = (p.L + q.L) / 2, Cbarp = (C1p + C2p) / 2;
  let hbar = h1 + h2;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1 - h2) > 180) hbar = h1 + h2 < 360 ? hbar + 360 : hbar - 360;
    hbar /= 2;
  }
  const T = 1 - 0.17 * Math.cos(rad(hbar - 30)) + 0.24 * Math.cos(rad(2 * hbar)) +
    0.32 * Math.cos(rad(3 * hbar + 6)) - 0.2 * Math.cos(rad(4 * hbar - 63));
  const dth = 30 * Math.exp(-(((hbar - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cbarp ** 7 / (Cbarp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbar - 50) ** 2) / Math.sqrt(20 + (Lbar - 50) ** 2);
  const Sc = 1 + 0.045 * Cbarp, Sh = 1 + 0.015 * Cbarp * T;
  const Rt = -Math.sin(rad(2 * dth)) * Rc;
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
}
function hue(b, ap) {
  if (ap === 0 && b === 0) return 0;
  let h = deg(Math.atan2(b, ap));
  return h < 0 ? h + 360 : h;
}
