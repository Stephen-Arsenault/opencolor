/**
 * Reference-dataset loading and nearest-color search.
 *
 * Data lives in ./data/<id>.json, listed by ./data/index.json (built by
 * scripts/sync-data.sh). Each dataset is normalized CIELAB (D65/2°).
 *
 * Search rules (per product decision):
 *   - ≥2 systems active (incl. the default "all"): return the single best match
 *     per system, ranked by ΔE — variety across systems, no near-duplicate spam.
 *   - exactly 1 system active: pool within that system and return the top N.
 */
import { ciede2000, labToRgb, closeness } from './color.js';
const POOL_SIZE = 12;
export class Matcher {
    systems = [];
    /** Load the dataset index and every listed system. */
    async load(base = './data') {
        const index = await fetchJson(`${base}/index.json`);
        const loaded = await Promise.all(index.map(async (e) => {
            try {
                const raw = await fetchJson(`${base}/${e.file}`);
                const colors = (raw.colors ?? []).filter((c) => Number.isFinite(c.L) && Number.isFinite(c.a) && Number.isFinite(c.b));
                return {
                    id: e.id,
                    label: e.label ?? raw.system ?? e.id,
                    illuminant: raw.illuminant,
                    observer: raw.observer,
                    colors,
                };
            }
            catch (err) {
                console.warn(`failed to load system ${e.id}:`, err.message);
                return null;
            }
        }));
        this.systems = loaded.filter((s) => s !== null && s.colors.length > 0);
    }
    /** All known system ids (for building the filter UI). */
    get systemIds() {
        return this.systems.map((s) => ({ id: s.id, label: s.label, count: s.colors.length }));
    }
    /**
     * Find matches for a scanned Lab. `activeIds` is the set of enabled systems;
     * empty or undefined means "all".
     */
    search(scan, activeIds) {
        // undefined/null ⇒ all systems; an (empty) set ⇒ exactly those ids, so an
        // empty set means "none enabled" (the all-filters-off state).
        const active = this.systems.filter((s) => !activeIds || activeIds.has(s.id));
        if (active.length === 0)
            return [];
        if (active.length === 1) {
            // Single system → pool: top N nearest within it.
            return this.nearestN(active[0], scan, POOL_SIZE);
        }
        // Multiple systems → best match per system, then rank across systems.
        const best = active
            .map((sys) => this.nearestN(sys, scan, 1)[0])
            .filter((m) => m !== undefined);
        best.sort((x, y) => x.dE - y.dE);
        return best;
    }
    nearestN(sys, scan, n) {
        const scored = sys.colors.map((c) => {
            const lab = { L: c.L, a: c.a, b: c.b };
            const dE = ciede2000(scan, lab);
            return { c, lab, dE };
        });
        scored.sort((x, y) => x.dE - y.dE);
        return scored.slice(0, n).map(({ c, lab, dE }) => ({
            systemId: sys.id,
            systemLabel: sys.label,
            code: c.code,
            name: c.name,
            lab,
            rgb: labToRgb(lab),
            dE,
            closeness: closeness(dE),
            method: c.method,
        }));
    }
}
async function fetchJson(url) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok)
        throw new Error(`${res.status} ${url}`);
    return res.json();
}
