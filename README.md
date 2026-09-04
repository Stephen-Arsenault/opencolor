# OpenColor

A Web Bluetooth app for the **Datacolor ColorReader** (PCE-1 / "Model Y")
colorimeter. Pair the device, scan a physical color, and match the measured
CIELAB against named color standards — RAL, Pantone, NCS, Munsell, and paint
fandecks (Sherwin-Williams, Benjamin Moore) — ranked by CIEDE2000 color
difference. Installable as a PWA.

Hosted at **opencolor.app** (`.app` forces HTTPS, which the Web Bluetooth and
service-worker secure-context requirements both need).

## Requirements

- **Chrome or Edge** on desktop or Android. Web Bluetooth is not available in
  Safari or on iOS (WebKit has no Web Bluetooth), so **iOS cannot scan**.
- A **secure context**: `https://` or `http://localhost`. Required for both Web
  Bluetooth and the service worker.

## Run locally

The app is static — no build step is needed to run it, `dist/` and `data/` are
committed:

```sh
npx serve .          # then open http://localhost:3000 in Chrome/Edge
```

To rebuild the TypeScript after editing `src/`:

```sh
npm ci
npm run build        # tsc → dist/
```

## Deploy (Cloudflare Pages)

The repo root **is** the site. Because `dist/` and `data/` are committed, Pages
needs no build:

- Framework preset: **None**
- Build command: *(empty)*
- Build output directory: **/**

(If you'd rather build on Pages, set the build command to `npm ci && npm run
build` and keep the output directory at `/`.)

## Layout

| Path | What |
|---|---|
| `index.html`, `styles.css` | App shell and styling |
| `src/` | TypeScript source |
| `dist/` | Compiled JS (committed, served directly) |
| `data/` | Reference color datasets + `index.json` manifest |
| `icons/`, `manifest.webmanifest`, `sw.js` | PWA assets |

### Source modules (`src/`)

- `colorreader.ts` — Web Bluetooth BRSP driver (connect, scan, calibrate).
- `color.ts` — CIELAB↔sRGB, CIEDE2000, closeness rating.
- `matcher.ts` — dataset loading and nearest-color search.
- `store.ts` — localStorage history and filter prefs.
- `app.ts` — UI controller.

## Reference data

`data/*.json` are CIELAB (D65/2°) datasets. Values are either published by the
source or derived from published hex (`method` field notes which). They were
compiled into the (gitignored) `archive/color_systems/` workspace and copied in;
regenerate with `archive/build-data.py`.

## Notes

- **Calibration** reads the white reference tile inside the cap. The device's
  calibrate ACK is authoritative (success vs. failure); a calibration that reads
  more than ΔE 1 from the reference white is flagged, and scans taken under a bad
  calibration are marked in the result and history.
- **Scan value** comes from the device's `0x95` Lab read (measured sample color,
  confirmed by real-device testing), surfaced through `ColorReader.scan()`.

## `archive/` (gitignored)

Local-only material kept out of the deployed app: the reverse-engineering report,
the reference Python drivers, PacketLogger captures, the data-collection
workspace, and the Node replay test.
