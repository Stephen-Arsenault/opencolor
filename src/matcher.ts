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

import { Lab, ciede2000, labToRgb, closeness, Closeness } from './color.js';

export interface RefColor {
  code: string;
  name: string;
  hex?: string;
  L: number;
  a: number;
  b: number;
  method?: string;
}

export interface RefSystem {
  id: string; // filename stem, e.g. "ral_classic"
  label: string; // display name, e.g. "RAL Classic"
  illuminant?: string;
  observer?: string;
  colors: RefColor[];
}

export interface Match {
  systemId: string;
  systemLabel: string;
  code: string;
  name: string;
  lab: Lab;
  rgb: string; // css color for the swatch
  dE: number;
  closeness: Closeness;
  method?: string;
}

interface IndexEntry {
  id: string;
  file: string;
  label: string;
  count?: number;
}

const POOL_SIZE = 12;

export class Matcher {
  systems: RefSystem[] = [];

  /** Load the dataset index and every listed system. */
  async load(base = './data'): Promise<void> {
    const index: IndexEntry[] = await fetchJson(`${base}/index.json`);
    const loaded = await Promise.all(
      index.map(async (e) => {
        try {
          const raw = await fetchJson(`${base}/${e.file}`);
          const colors: RefColor[] = (raw.colors ?? []).filter(
            (c: RefColor) => Number.isFinite(c.L) && Number.isFinite(c.a) && Number.isFinite(c.b),
          );
          return {
            id: e.id,
            label: e.label ?? raw.system ?? e.id,
            illuminant: raw.illuminant,
            observer: raw.observer,
            colors,
          } as RefSystem;
        } catch (err) {
          console.warn(`failed to load system ${e.id}:`, (err as Error).message);
          return null;
        }
      }),
    );
    this.systems = loaded.filter((s): s is RefSystem => s !== null && s.colors.length > 0);
  }

  /** All known system ids (for building the filter UI). */
  get systemIds(): { id: string; label: string; count: number }[] {
    return this.systems.map((s) => ({ id: s.id, label: s.label, count: s.colors.length }));
  }

  /**
   * Find matches for a scanned Lab. `activeIds` is the set of enabled systems;
   * empty or undefined means "all".
   */
  search(scan: Lab, activeIds?: Set<string>): Match[] {
    // undefined/null ⇒ all systems; an (empty) set ⇒ exactly those ids, so an
    // empty set means "none enabled" (the all-filters-off state).
    const active = this.systems.filter((s) => !activeIds || activeIds.has(s.id));
    if (active.length === 0) return [];

    if (active.length === 1) {
      // Single system → pool: top N nearest within it.
      return this.nearestN(active[0], scan, POOL_SIZE);
    }
    // Multiple systems → best match per system, then rank across systems.
    const best = active
      .map((sys) => this.nearestN(sys, scan, 1)[0])
      .filter((m): m is Match => m !== undefined);
    best.sort((x, y) => x.dE - y.dE);
    return best;
  }

  private nearestN(sys: RefSystem, scan: Lab, n: number): Match[] {
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

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}
