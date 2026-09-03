/**
 * Browser-persistent state: scan history (capped) and filter preferences.
 * Uses localStorage — small, synchronous, survives close/reopen.
 */

import { Lab } from './color.js';

const HISTORY_KEY = 'colorreader.history.v1';
const FILTER_KEY = 'colorreader.filters.v1';
const HISTORY_CAP = 25;

export interface MatchSummary {
  systemId: string;
  systemLabel: string;
  code: string;
  name: string;
  rgb: string;
  dE: number;
}

export interface ScanRecord {
  id: string; // unique, sortable
  ts: number; // epoch ms
  lab: Lab;
  rgb: string; // swatch of the scan itself
  top?: MatchSummary; // closest match at scan time (for the history row)
  calSuspect?: boolean; // calibration was failed/questionable when this was scanned
}

export function loadHistory(): ScanRecord[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? (JSON.parse(raw) as ScanRecord[]) : [];
  } catch {
    return [];
  }
}

/** Prepend a record, cap the list, persist, and return the new list. */
export function pushHistory(rec: ScanRecord): ScanRecord[] {
  const list = [rec, ...loadHistory()].slice(0, HISTORY_CAP);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
  } catch {
    /* quota / private mode — history just won't persist */
  }
  return list;
}

export function clearHistory(): void {
  try {
    localStorage.removeItem(HISTORY_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Filter prefs. We persist the set of ACTIVE system ids. `null` means "all
 * systems" (the default) and stays robust as new datasets are added later.
 */
export function loadActiveFilters(): Set<string> | null {
  try {
    const raw = localStorage.getItem(FILTER_KEY);
    if (!raw) return null;
    const arr = JSON.parse(raw) as string[] | null;
    return arr ? new Set(arr) : null;
  } catch {
    return null;
  }
}

export function saveActiveFilters(active: Set<string> | null): void {
  try {
    if (active === null) localStorage.removeItem(FILTER_KEY);
    else localStorage.setItem(FILTER_KEY, JSON.stringify([...active]));
  } catch {
    /* ignore */
  }
}
