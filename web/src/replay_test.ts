/**
 * Replay test: feed the exact BRSP wire bytes from the Apple PacketLogger
 * captures through BrspStream + the TS decoders (run under Node).
 * Mirrors the mock-replay that validated the Python driver.
 */
import { readFileSync } from 'node:fs';
import { BrspStream, nibdec, decodeDeviceInfo, decodeStatus, decodeSlot, decodeMeasurement, decodeCalLab } from './colorreader.js';

/** Parse the .pklg container; return ordered (dir, payload) records. */
function parsePklg(path: string): Array<{ dir: number; payload: Uint8Array }> {
  const data = readFileSync(path);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const recs: Array<{ dir: number; payload: Uint8Array }> = [];
  let off = 0;
  while (off + 4 <= data.byteLength) {
    const rlen = dv.getUint32(off, true);
    if (rlen < 9 || off + 4 + rlen > data.byteLength) break;
    const dir = data[off + 12];
    const payload = data.subarray(off + 13, off + 4 + rlen);
    recs.push({ dir, payload });
    off += 4 + rlen;
  }
  return recs;
}

/** Extract ordered host<->device BRSP logical messages (same rules as the Python extractor). */
function brspMessages(path: string): Array<{ dir: 'W' | 'I'; wire: Uint8Array }> {
  const recs = parsePklg(path);
  const events: Array<{ idx: number; k: 'W' | 'I'; v: Uint8Array }> = [];
  recs.forEach(({ dir, payload }, idx) => {
    const find = (pat: number[]) => {
      outer: for (let i = 0; i + pat.length <= payload.length; i++) {
        for (let j = 0; j < pat.length; j++) if (payload[i + j] !== pat[j]) continue outer;
        return i;
      }
      return -1;
    };
    if (dir === 0x02) {
      const k = find([0x12, 0x1a, 0x00]); // ATT Write Request, handle 0x001A
      if (k >= 0) events.push({ idx, k: 'W', v: payload.subarray(k + 3) });
    } else if (dir === 0x03) {
      const k = find([0x1d, 0x1c, 0x00]); // ATT Handle Value Indication, handle 0x001C
      if (k >= 0) events.push({ idx, k: 'I', v: payload.subarray(k + 3) });
    }
  });

  const cur: Record<'W' | 'I', number[]> = { W: [], I: [] };
  const out: Array<{ dir: 'W' | 'I'; wire: Uint8Array }> = [];
  for (const { k, v } of events) {
    cur[k].push(...v);
    const b = cur[k];
    let i = 0;
    for (;;) {
      if (b[i] === 0x02) {
        const etx = b.indexOf(0x03, i);
        if (etx < 0) break;
        out.push({ dir: k, wire: Uint8Array.from(b.slice(i + 1, etx)) });
        i = etx + 1;
      } else i++;
      if (i >= b.length) break;
    }
    cur[k] = b.slice(i);
  }
  return out;
}

let failures = 0;
for (const cap of ['confirmed', 'calibrate']) {
  const path = `/home/hermeswebui/.hermes/attachments/ppg_colorreader_btle_${cap}.pklg`;
  const msgs = brspMessages(path);
  console.log(`=== ${cap}: ${msgs.length} logical messages ===`);
  // Feed everything through one BrspStream in capture order, 17-byte chunks to force fragmentation.
  const stream = new BrspStream();
  const decoded: Uint8Array[] = [];
  for (const { wire } of msgs) {
    const full = new Uint8Array(wire.length + 2);
    full[0] = 0x02;
    full.set(wire, 1);
    full[full.length - 1] = 0x03;
    for (let i = 0; i < full.length; i += 17) decoded.push(...stream.feed(full.subarray(i, i + 17)));
  }
  for (const m of decoded) {
    const h = m[0];
    try {
      if (h === 0xc5) console.log('  info: ', JSON.stringify(decodeDeviceInfo(m)));
      else if (h === 0xc2) console.log('  stat: ', JSON.stringify(decodeStatus(m)));
      else if (h === 0xc4 && m[1] === 0x95) console.log('  lab:  ', JSON.stringify(decodeCalLab(m)));
      else if (h === 0xc4 && m.length === 8) console.log('  slot: ', JSON.stringify(decodeSlot(m)));
      else if (h === 0xc4) console.log('  ack:  ', [...m].map((x) => x.toString(16)).join(' '));
      else if (h === 0x00 && m[1] === 0x93) console.log('  meas: ', JSON.stringify(decodeMeasurement(m)));
      else if (h === 0x80 || h === 0x92 || h === 0x93 || h === 0x95) console.log('  cmd:  ', [...m].map((x) => x.toString(16)).join(' '));
      else {
        console.log('  ?? unknown:', [...m].map((x) => x.toString(16)).join(' '));
        failures++;
      }
    } catch (e) {
      console.log('  DECODE FAIL:', (e as Error).message);
      failures++;
    }
  }
  // Key value assertions against the captures:
  if (cap === 'confirmed') {
    const lab = decoded.find((m) => m[0] === 0xc4 && m[1] === 0x95);
    if (!lab) { console.log('  MISSING LAB FRAME'); failures++; continue; }
    const l = decodeCalLab(lab);
    const ok = Math.abs(l.Lstar - 93.964) < 0.01 && Math.abs(l.astar - 0.058) < 0.01 && Math.abs(l.bstar - 1.246) < 0.01;
    console.log(`  Lab assert: L*=${l.Lstar.toFixed(3)} a*=${l.astar.toFixed(3)} b*=${l.bstar.toFixed(3)} ${ok ? 'OK' : 'FAIL'}`);
    if (!ok) failures++;
    const info = decoded.find((m) => m[0] === 0xc5);
    if (info && decodeDeviceInfo(info).serial !== '900141759') { console.log('  SERIAL MISMATCH'); failures++; }
  }
}
console.log(failures === 0 ? '\nALL REPLAY TESTS PASSED' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
