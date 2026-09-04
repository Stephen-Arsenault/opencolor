/**
 * OpenColor match app — UI controller.
 *
 * Flow: Pair connects once and stays connected; Match Color runs a scan on the
 * live link and ranks it against the reference datasets; results show as a hero
 * (your scan vs. closest match) plus a gallery ranked by closeness. History and
 * filter prefs persist in the browser.
 */

import { ColorReader, CalLab } from './colorreader.js';
import { Lab, labToRgb, inGamut, ciede2000 } from './color.js';
import { Matcher, Match } from './matcher.js';
import {
  loadHistory,
  pushHistory,
  clearHistory,
  loadActiveFilters,
  saveActiveFilters,
  ScanRecord,
} from './store.js';

type ConnState = 'idle' | 'connecting' | 'connected' | 'disconnected';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const reader = new ColorReader();
const matcher = new Matcher();
let activeFilters: Set<string> | null = loadActiveFilters();
let lastScan: Lab | null = null;
let connState: ConnState = 'idle';
// True once a calibration this session failed or read ΔE > 1 from white. Scans
// taken while true are flagged (their colors are unreliable). Unknown at startup
// ⇒ false (we can't judge the device's prior calibration without recalibrating).
let calSuspect = false;

// --------------------------------------------------------------------------
// Connection state → Pair button
// --------------------------------------------------------------------------

function setConn(state: ConnState) {
  connState = state;
  const btn = $('pair') as HTMLButtonElement;
  const map: Record<ConnState, [string, string, boolean]> = {
    idle: ['Pair', '', false],
    connecting: ['Connecting…', 'is-connecting', true],
    connected: ['Connected', 'is-connected', false],
    disconnected: ['Disconnected', 'is-disconnected', false],
  };
  const [label, cls, disabled] = map[state];
  btn.textContent = label;
  btn.className = `pill ${cls}`.trim();
  btn.disabled = disabled;
}

reader.onDisconnect = () => setConn('disconnected');

/** Ensure a live connection; connects (user-gesture path) if needed. */
async function ensureConnected(): Promise<void> {
  if (reader.connected) return;
  setConn('connecting');
  try {
    await reader.connect();
    setConn('connected');
  } catch (e) {
    setConn(connState === 'connecting' ? 'idle' : connState);
    throw e;
  }
}

// --------------------------------------------------------------------------
// Actions
// --------------------------------------------------------------------------

async function onPair() {
  if (reader.connected) {
    await reader.disconnect();
    setConn('idle');
    return;
  }
  try {
    await ensureConnected();
  } catch (e) {
    toast((e as Error).message);
  }
}

async function onMatch() {
  const btn = $('match') as HTMLButtonElement;
  btn.disabled = true;
  // Only reveal the spinner if the scan is actually slow (>1s), to signal work.
  const spinTimer = setTimeout(() => btn.classList.add('loading'), 1000);
  try {
    await ensureConnected();
    const { lab } = await reader.scan();
    lastScan = lab;
    const matches = matcher.search(lab, activeFilters ?? undefined);
    renderResult(lab, matches);
    recordScan(lab, matches[0]);
  } catch (e) {
    toast((e as Error).message);
  } finally {
    clearTimeout(spinTimer);
    btn.classList.remove('loading');
    btn.disabled = false;
  }
}

async function onCalibrate() {
  const btn = $('calibrate') as HTMLButtonElement;
  btn.disabled = true;
  try {
    await ensureConnected();
    const { ok, lab } = await reader.calibrate();
    const r = validateCalibration(ok, lab);
    calSuspect = r.level !== 'success';
    toast(r.msg, r.level);
  } catch (e) {
    toast((e as Error).message, 'error');
  } finally {
    btn.disabled = false;
  }
}

// Calibration validity, three states:
//   error   — device ACK said the reference wasn't read (status 0x00).
//   warn    — device accepted it, but the reference reads too far from the known
//             white tile (ΔE > 1) ⇒ calibrated against the wrong surface (cap off
//             onto a desk, dirty chip, …). A dirty desk measured ΔE 3.1.
//   success — accepted and reads white (ΔE ≤ 1); good cals sit at ~0.2–0.5.
// WHITE_REF is the white tile's measured Lab — the same value that matches
// Sherwin-Williams SW 9542 "Natural White".
const WHITE_REF: Lab = { L: 93.9, a: 0.12, b: 1.7 };
const CAL_WARN_DE = 1;

function validateCalibration(ok: boolean, lab: CalLab | null): { msg: string; level: ToastLevel } {
  if (!ok) {
    return { level: 'error', msg: '⚠ Calibration failed — the white reference wasn’t read. Is the cap on?' };
  }
  if (!lab) return { level: 'success', msg: 'Calibrated ✓' };
  const dE = ciede2000({ L: lab.Lstar, a: lab.astar, b: lab.bstar }, WHITE_REF);
  if (dE > CAL_WARN_DE) {
    return {
      level: 'warn',
      msg: `⚠ Calibration questionable — reference reads ΔE ${dE.toFixed(1)} from white. Cap off or reference dirty?`,
    };
  }
  return { level: 'success', msg: `Calibrated ✓ · reference reads white (ΔE ${dE.toFixed(1)}).` };
}

// --------------------------------------------------------------------------
// Rendering
// --------------------------------------------------------------------------

/** Fill the bottom (match) portion of the hero from a match. */
function applyHeroMatch(m: Match) {
  $('match-swatch').style.background = m.rgb;
  $('match-name').textContent = m.name || m.code;
  $('match-code').textContent = `${m.systemLabel} · ${m.code}`;
  $('match-close').textContent = `${m.closeness.label} · ΔE ${m.dE.toFixed(1)}`;
  $('match-meter').style.setProperty('--score', String(m.closeness.score));
}

function renderResult(scan: Lab, matches: Match[], suspect = calSuspect) {
  const result = $('result');
  result.hidden = false;
  $('cal-warn-badge').hidden = !suspect;

  $('scan-swatch').style.background = labToRgb(scan);
  $('scan-lab').textContent = fmtLab(scan);

  const best = matches[0];
  const hero = $('hero-match');
  const gallery = $('gallery');
  if (!best) {
    // No systems enabled (all filters off): show the device's own sample filling
    // the panel, with its Lab (in the "Your scan" chip), and note matching is off.
    hero.hidden = false;
    $('match-swatch').style.background = labToRgb(scan);
    $('match-name').textContent = 'No color systems enabled';
    $('match-code').textContent = 'Enable a system under “Filter color systems” to see matches.';
    $('match-close').textContent = '';
    $('match-meter').style.setProperty('--score', '0');
    const note = document.createElement('p');
    note.className = 'gallery-note muted';
    note.textContent = 'All color systems are disabled.';
    gallery.replaceChildren(note);
    return;
  }
  hero.hidden = false;
  applyHeroMatch(best);
  // Gallery: all matches (best-per-system or single-system pool), ranked. The
  // first (closest) is selected into the hero by default; clicking any card
  // swaps it in so you can eyeball it against your scan.
  gallery.replaceChildren(...matches.map((m, i) => card(m, i === 0)));
}

function card(m: Match, selected: boolean): HTMLElement {
  const el = document.createElement('button');
  el.className = `card${selected ? ' selected' : ''}`;
  el.title = `${m.systemLabel} ${m.code} — ΔE ${m.dE.toFixed(2)}`;
  const sw = document.createElement('div');
  sw.className = 'card-swatch';
  sw.style.background = m.rgb;
  if (!inGamut(m.lab)) sw.classList.add('oog'); // out-of-gamut hint
  const meta = document.createElement('div');
  meta.className = 'card-meta';
  const displayName = m.name || m.code;
  // Show the standard's identifier (e.g. "RAL 3026") on its own line, unless it's
  // the same string we're already showing as the name (CSS, Pantone, …).
  const codeLine = m.code && m.code !== displayName ? `<span class="card-code">${escape(m.code)}</span>` : '';
  meta.innerHTML =
    `<span class="card-name">${escape(displayName)}</span>` +
    codeLine +
    `<span class="card-sys">${escape(m.systemLabel)}</span>` +
    `<span class="card-de">${m.closeness.label} · ΔE ${m.dE.toFixed(1)}</span>`;
  el.append(sw, meta);
  el.onclick = () => {
    applyHeroMatch(m);
    el.parentElement?.querySelectorAll('.card.selected').forEach((c) => c.classList.remove('selected'));
    el.classList.add('selected');
  };
  return el;
}

// --------------------------------------------------------------------------
// History
// --------------------------------------------------------------------------

function recordScan(lab: Lab, best?: Match) {
  const rec: ScanRecord = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    ts: Date.now(),
    lab,
    rgb: labToRgb(lab),
    calSuspect,
    top: best && {
      systemId: best.systemId,
      systemLabel: best.systemLabel,
      code: best.code,
      name: best.name,
      rgb: best.rgb,
      dE: best.dE,
    },
  };
  renderHistory(pushHistory(rec));
}

function renderHistory(list: ScanRecord[]) {
  const box = $('history-list');
  if (list.length === 0) {
    box.innerHTML = '<p class="muted">No scans yet.</p>';
    return;
  }
  box.replaceChildren(
    ...list.map((r) => {
      const row = document.createElement('button');
      row.className = 'hist-row';
      const t = new Date(r.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      let main = 'no match';
      let sub = '';
      if (r.top) {
        const displayName = r.top.name || r.top.code;
        main = escape(displayName);
        // Lead the sub-line with the standard identifier (e.g. "RAL 3026") when
        // it differs from the shown name.
        const codePart = r.top.code && r.top.code !== displayName ? `${escape(r.top.code)} · ` : '';
        sub = `${codePart}${escape(r.top.systemLabel)} · ΔE ${r.top.dE.toFixed(1)}`;
      }
      const warn = r.calSuspect
        ? '<span class="warn-badge" title="Scanned under an unreliable calibration (reference ΔE &gt; 1 from white). Colors may be inaccurate.">⚠</span> '
        : '';
      row.innerHTML =
        `<span class="hist-sw" style="background:${r.rgb}"></span>` +
        `<span class="hist-main">${warn}${main}<span class="hist-sub">${sub}</span></span>` +
        `<span class="hist-time">${t}</span>`;
      row.onclick = () => reshow(r);
      return row;
    }),
  );
}

/** Re-run the match for a stored scan against the *current* filters. */
function reshow(r: ScanRecord) {
  lastScan = r.lab;
  renderResult(r.lab, matcher.search(r.lab, activeFilters ?? undefined), r.calSuspect ?? false);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// --------------------------------------------------------------------------
// Filters
// --------------------------------------------------------------------------

function buildFilters() {
  const box = $('filter-list');
  const ids = matcher.systemIds;
  box.replaceChildren(
    ...ids.map(({ id, label, count }) => {
      const wrap = document.createElement('label');
      wrap.className = 'chk';
      wrap.title = label;
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = activeFilters === null || activeFilters.has(id);
      cb.onchange = () => onFilterChange(id, cb.checked, ids.map((i) => i.id));
      const name = document.createElement('span');
      name.className = 'chk-name';
      name.textContent = label;
      const cnt = document.createElement('span');
      cnt.className = 'chk-count';
      cnt.textContent = count.toLocaleString();
      wrap.append(cb, name, cnt);
      return wrap;
    }),
  );
}

function onFilterChange(id: string, on: boolean, allIds: string[]) {
  // Materialize "all" into a concrete set the first time one is toggled off.
  if (activeFilters === null) activeFilters = new Set(allIds);
  if (on) activeFilters.add(id);
  else activeFilters.delete(id);
  // Collapse back to null (=all) when everything is on again — keeps future
  // datasets auto-included.
  if (allIds.every((i) => activeFilters!.has(i))) activeFilters = null;
  saveActiveFilters(activeFilters);
  if (lastScan) renderResult(lastScan, matcher.search(lastScan, activeFilters ?? undefined));
}

// --------------------------------------------------------------------------
// Misc helpers
// --------------------------------------------------------------------------

type ToastLevel = 'info' | 'success' | 'warn' | 'error';
let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(msg: string, level: ToastLevel = 'info') {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast show ${level}`;
  clearTimeout(toastTimer);
  // Hold warnings/errors longer so they can actually be read.
  toastTimer = setTimeout(() => t.classList.remove('show'), level === 'warn' || level === 'error' ? 6000 : 3200);
}

const fmtLab = (l: Lab) => `L* ${l.L.toFixed(1)}  a* ${l.a.toFixed(1)}  b* ${l.b.toFixed(1)}`;
const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const textNode = (s: string) => document.createTextNode(s);
function spanMuted(s: string) {
  const el = document.createElement('span');
  el.className = 'muted';
  el.textContent = s;
  return el;
}

// --------------------------------------------------------------------------
// PWA install affordance
// --------------------------------------------------------------------------

// The browser tells us installability via beforeinstallprompt/appinstalled and
// whether we're launched as an installed app via display-mode. It self-corrects:
// Chrome re-fires beforeinstallprompt after an uninstall. There is NO web API to
// uninstall a PWA, so the "Uninstall" affordance points the user to the browser.
let deferredPrompt: any = null;
type InstallState = 'hidden' | 'install' | 'installed';

function setInstall(state: InstallState) {
  const btn = $('install') as HTMLButtonElement;
  if (state === 'hidden') {
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  if (state === 'install') {
    btn.textContent = 'Install';
    btn.title = 'Install this app';
    btn.onmouseenter = btn.onmouseleave = null;
  } else {
    btn.textContent = 'Installed';
    btn.title = 'Installed — remove it from your browser or OS app menu';
    // Hover hints at uninstall (which only the browser can actually perform).
    btn.onmouseenter = () => (btn.textContent = 'Uninstall');
    btn.onmouseleave = () => (btn.textContent = 'Installed');
  }
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  setInstall('install');
});
window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  setInstall('installed');
});
$('install').onclick = async () => {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    return; // appinstalled will flip the label if they accepted
  }
  // Installed state: we can't uninstall programmatically — tell the user how.
  toast('To uninstall, use your browser’s app menu (⋮ → Uninstall) or your OS app list.');
};

// Already running as an installed app?
if (window.matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone) {
  setInstall('installed');
}

// --------------------------------------------------------------------------
// Boot
// --------------------------------------------------------------------------

async function boot() {
  $('pair').onclick = onPair;
  $('match').onclick = onMatch;
  $('calibrate').onclick = onCalibrate;
  $('clear-history').onclick = () => {
    clearHistory();
    renderHistory([]);
  };

  // Expose the driver for console protocol debugging: `ColorReader.debug = true`
  // logs every raw TX/RX frame (used to find the cap-on/off discriminator).
  (window as unknown as Record<string, unknown>).ColorReader = ColorReader;

  if (!('bluetooth' in navigator)) {
    toast('Web Bluetooth unavailable — use Chrome/Edge on desktop or Android.');
    ($('match') as HTMLButtonElement).disabled = true;
    ($('pair') as HTMLButtonElement).disabled = true;
  }

  renderHistory(loadHistory());
  try {
    await matcher.load();
    buildFilters();
    $('data-count').textContent = `${matcher.systems.reduce((n, s) => n + s.colors.length, 0).toLocaleString()} colors · ${matcher.systems.length} systems`;
  } catch (e) {
    toast(`Failed to load color data: ${(e as Error).message}`);
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => undefined);
  }
}

boot();
