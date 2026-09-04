/**
 * Datacolor ColorReader (PCE-1 / "Model Y") — BRSP driver over Web Bluetooth.
 *
 * Protocol reverse-engineered from Apple PacketLogger captures of the official
 * app. The reference Python driver and the annotated protocol write-up are kept
 * out of the deployed app (see the archive/ directory).
 *
 * TRANSPORT
 *   GATT service  da2b84f1-6279-48de-bdc0-afbea0226079  (BlueRadios BRSP UART)
 *   Host → device : Write Request  char bf03260c-… (handle 0x001A)
 *   Device → host : Indications    char 18cda784-… (handle 0x001C)
 *   CCCD 0x2902 on the RX char ← startNotifications() (writes 0x0002 for us)
 *
 * BRSP FRAMING
 *   0x02 STX + ASCII(nibble+0x30 of payload+checksum) + 0x03 ETX
 *   checksum: last byte = sum(previous bytes) & 0xFF
 *   One logical message may span several ~60 ms indications.
 *
 * SECURITY: navigator.bluetooth requires a secure context (https:// or
 * http://localhost) and a user gesture. requestDevice() must be called
 * directly from a click/keypress handler.
 */
// ---------------------------------------------------------------------------
// GATT constants (verified against GATT discovery traffic)
// ---------------------------------------------------------------------------
export const BRSP_SERVICE = 'da2b84f1-6279-48de-bdc0-afbea0226079';
export const CH_BRSP_TX = 'bf03260c-7205-4c25-af43-93b1c299d159'; // write, handle 0x001A
export const CH_BRSP_RX = '18cda784-4bd3-4370-85bb-bfed91ec86af'; // indicate, handle 0x001C
export const CH_BRSP_CFG = 'a87988b9-694c-479c-900e-95dfa6c00a24'; // write 0x01 (0x0018)
export const CH_BRSP_MODE = 'fdd6b4d3-046d-4330-bdec-1fd0c90cb43b'; // write+notify (0x0021)
const STX = 0x02;
const ETX = 0x03;
// ---------------------------------------------------------------------------
// BRSP codec
// ---------------------------------------------------------------------------
/** raw bytes → wire ASCII (each nibble + 0x30) */
export function nibenc(bytes) {
    const out = new Uint8Array(bytes.length * 2);
    for (let i = 0; i < bytes.length; i++) {
        out[i * 2] = (bytes[i] >> 4) + 0x30;
        out[i * 2 + 1] = (bytes[i] & 0x0f) + 0x30;
    }
    return out;
}
/** wire ASCII → raw bytes; returns null on a non-BRSP character */
export function nibdec(wire) {
    if (wire.length % 2 !== 0)
        return null;
    const out = new Uint8Array(wire.length / 2);
    for (let i = 0; i < out.length; i++) {
        const hi = wire[i * 2] - 0x30;
        const lo = wire[i * 2 + 1] - 0x30;
        if (hi < 0 || hi > 15 || lo < 0 || lo > 15)
            return null;
        out[i] = (hi << 4) | lo;
    }
    return out;
}
/** STX + nibble-encoded(payload + additive checksum) + ETX */
export function frame(payload) {
    let sum = 0;
    for (const b of payload)
        sum = (sum + b) & 0xff;
    const body = new Uint8Array(payload.length + 1);
    body.set(payload, 0);
    body[payload.length] = sum;
    const enc = nibenc(body); // 2 wire chars per body byte
    const out = new Uint8Array(enc.length + 2);
    out[0] = STX;
    out.set(enc, 1);
    out[out.length - 1] = ETX;
    return out;
}
/** Copy a view into a plain ArrayBuffer-backed Uint8Array (Web Bluetooth needs BufferSource). */
function plain(bytes) {
    const out = new Uint8Array(new ArrayBuffer(bytes.byteLength));
    out.set(bytes, 0);
    return out;
}
const textDecoder = new TextDecoder();
/**
 * Accumulates indication fragments; emits complete, checksum-verified
 * decoded messages. Stray bytes between messages (fragment gaps) resync.
 */
export class BrspStream {
    buf = [];
    /** feed raw GATT indication bytes; returns newly completed messages */
    feed(data) {
        this.buf.push(...data);
        const done = [];
        for (;;) {
            const stx = this.buf.indexOf(STX);
            if (stx < 0) {
                this.buf = [];
                break;
            }
            const etx = this.buf.indexOf(ETX, stx + 1);
            if (etx < 0) {
                this.buf = this.buf.slice(stx); // keep partial message
                break;
            }
            const wire = Uint8Array.from(this.buf.slice(stx + 1, etx));
            const dec = nibdec(wire);
            if (dec) {
                const body = dec.subarray(0, -1);
                const cks = dec[dec.length - 1];
                const sum = body.reduce((a, b) => (a + b) & 0xff, 0);
                // Emit the full message *including* the trailing checksum byte (matches the
                // Python driver). decodeSlot's ready word (01 46) reuses the checksum byte as
                // its low byte, so stripping it here would break slot-ready detection.
                if (sum === cks)
                    done.push(dec);
                else
                    console.warn(`[brsp] bad checksum: want ${cks.toString(16)} got ${sum.toString(16)}`);
            }
            else {
                console.warn('[brsp] undecodable frame dropped');
            }
            this.buf = this.buf.slice(etx + 1);
            if (this.buf.length === 0)
                break;
        }
        return done;
    }
}
// ---------------------------------------------------------------------------
// Commands (decoded payloads; frame() wraps for the wire)
// ---------------------------------------------------------------------------
export const CMD_DEVICE_INFO = Uint8Array.of(0x80, 0x04);
export const CMD_GET_STATUS = Uint8Array.of(0x80, 0x01);
export const CMD_CHECK_SLOT = Uint8Array.of(0x80, 0x09);
export const CMD_READ_MEAS = Uint8Array.of(0x93, 0xff);
export const CMD_READ_CAL_LAB = Uint8Array.of(0x95, 0x00);
/** CALIBRATE (white-reference check) — from ppg_colorreader_btle_calibrate.pklg */
export const CMD_CALIBRATE = Uint8Array.of(0x92, 0xff, 0x88, 0x59, 0x43, 0x6a);
/** MATCH trigger — from ppg_colorreader_btle_confirmed.pklg */
export const CMD_MATCH = Uint8Array.of(0x92, 0x00, 0xe7, 0x54, 0x43, 0x6a);
export function decodeDeviceInfo(dec) {
    if (dec[0] !== 0xc5)
        throw new Error(`unexpected info response: ${hex(dec)}`);
    const ascii = dec.subarray(12, 22);
    const end = ascii.indexOf(0);
    return {
        serial: textDecoder.decode(end < 0 ? ascii : ascii.subarray(0, end)),
        rawHex: hex(dec),
    };
}
export function decodeStatus(dec) {
    if (dec[0] !== 0xc2)
        throw new Error(`unexpected status response: ${hex(dec)}`);
    const fw = dec.subarray(1, 6);
    const fwEnd = fw.indexOf(0);
    const state = dec.subarray(12, 22);
    const stateEnd = state.indexOf(0);
    return {
        fw: textDecoder.decode(fwEnd < 0 ? fw : fw.subarray(0, fwEnd)),
        state: textDecoder.decode(stateEnd < 0 ? state : state.subarray(0, stateEnd)),
    };
}
export function decodeSlot(dec) {
    if (dec[0] !== 0xc4)
        throw new Error(`unexpected slot response: ${hex(dec)}`);
    const frameLen = (dec[6] << 8) | dec[7]; // big-endian u16, 0x0146 ⇒ 44-byte frame
    return { ready: frameLen === 0x0146, frameLen: frameLen === 0x0146 ? 44 : frameLen };
}
export function decodeMeasurement(dec) {
    if (dec[0] !== 0x00 || dec[1] !== 0x93)
        throw new Error(`unexpected measurement: ${hex(dec)}`);
    const dv = new DataView(dec.buffer, dec.byteOffset, dec.byteLength);
    const slotBytes = dec.subarray(27, 29);
    return {
        status: dec[0],
        adcScan: dec[2],
        tag: hex(dec.subarray(3, 10)),
        integrator: dv.getInt16(12),
        spectralA: dv.getUint16(21),
        standardSlot: String.fromCharCode(slotBytes[0], slotBytes[1]),
        gainIndex: dec[37],
    };
}
export function decodeCalLab(dec) {
    if (dec[0] !== 0xc4 || dec[1] !== 0x95)
        throw new Error(`unexpected Lab response: ${hex(dec)}`);
    const dv = new DataView(dec.buffer, dec.byteOffset, dec.byteLength);
    return {
        adc: dec[2],
        id: hex(dec.subarray(3, 6)),
        Lstar: dv.getFloat32(6, true),
        astar: dv.getFloat32(10, true),
        bstar: dv.getFloat32(14, true),
    };
}
function hex(b) {
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// ---------------------------------------------------------------------------
// Device driver
// ---------------------------------------------------------------------------
export class ColorReader {
    device = null;
    server = null;
    rxChar = null;
    stream = new BrspStream();
    queue = [];
    resolvers = [];
    /** Log raw TX/RX frames to the console for protocol bring-up. Set true to trace. */
    static debug = false;
    /** Fired when the GATT link drops (device sleep, out of range, unpair). */
    onDisconnect = null;
    /** Must be called from a user-gesture handler (click). */
    static async requestDevice() {
        if (!('bluetooth' in navigator)) {
            throw new Error('Web Bluetooth not available. Use Chrome/Edge (desktop or Android) over HTTPS.');
        }
        // The device advertises its name as "DC_<serial>" (e.g. DC_900141759) in the
        // ADV_IND, and the 128-bit BRSP service UUID only in the SCAN_RSP. macOS
        // CoreBluetooth doesn't reliably expose the scan-response service for filter
        // matching, so match on the name prefix; keep the service filter as a fallback.
        return navigator.bluetooth.requestDevice({
            filters: [
                { namePrefix: 'DC_' },
                { services: [BRSP_SERVICE] },
            ],
            optionalServices: [BRSP_SERVICE],
        });
    }
    async connect(device) {
        this.device = device ?? (await ColorReader.requestDevice());
        if (ColorReader.debug)
            console.log(`connecting to ${this.device.name ?? '(unnamed)'} …`);
        this.device.addEventListener('gattserverdisconnected', () => {
            this.rxChar = null;
            this.onDisconnect?.();
        });
        this.server = await this.device.gatt.connect();
        const service = await this.server.getPrimaryService(BRSP_SERVICE);
        this.rxChar = await service.getCharacteristic(CH_BRSP_RX);
        await this.rxChar.startNotifications();
        this.rxChar.addEventListener('characteristicvaluechanged', (ev) => {
            const dv = ev.target.value;
            const chunk = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
            if (ColorReader.debug)
                console.log('  RX chunk:', hex(chunk));
            for (const msg of this.stream.feed(chunk)) {
                if (ColorReader.debug)
                    console.log('  RX msg  :', hex(msg), `(${msg.length}B)`);
                const r = this.resolvers.shift();
                if (r)
                    r(msg);
                else
                    this.queue.push(msg);
            }
        });
        // Session-open writes the stock app performs.
        const cfg = await service.getCharacteristic(CH_BRSP_CFG);
        await cfg.writeValue(Uint8Array.of(0x01)).catch(() => undefined);
        const mode = await service.getCharacteristic(CH_BRSP_MODE);
        await mode.writeValue(Uint8Array.of(0x01)).catch(() => undefined);
        await sleep(200);
    }
    get connected() {
        return this.server?.connected ?? false;
    }
    async disconnect() {
        // stopNotifications clears the CCCD (0x0000) — the clean close seen in the capture.
        try {
            await this.rxChar?.stopNotifications();
        }
        catch {
            /* already gone */
        }
        try {
            this.server?.disconnect();
        }
        catch {
            /* already gone */
        }
        this.device = this.server = this.rxChar = null;
        this.queue = [];
        this.resolvers = [];
    }
    /** Send a command, resolve with the first complete response message. */
    async transact(payload, timeoutMs = 6000) {
        if (!this.rxChar)
            throw new Error('not connected');
        const tx = await (await this.rxChar.service).getCharacteristic(CH_BRSP_TX);
        let timer;
        const p = new Promise((resolve, reject) => {
            this.resolvers.push(resolve);
            timer = setTimeout(() => {
                const i = this.resolvers.indexOf(resolve);
                if (i >= 0) {
                    this.resolvers.splice(i, 1);
                    reject(new Error('BRSP response timeout'));
                }
            }, timeoutMs);
        });
        const queued = this.queue.shift();
        if (queued) {
            clearTimeout(timer);
            this.resolvers.pop()(queued);
        }
        const wire = frame(payload);
        if (ColorReader.debug)
            console.log('TX cmd   :', hex(payload), ' wire:', hex(wire));
        await tx.writeValue(plain(wire));
        return p;
    }
    /** Poll 80 09 until the device reports a 44-byte frame in the slot. */
    async waitSlotReady(timeoutMs = 20000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (decodeSlot(await this.transact(CMD_CHECK_SLOT)).ready)
                return;
            await sleep(300);
        }
        throw new Error('data slot never became ready');
    }
    /**
     * CALIBRATE — measure against the known white reference (inside the cap).
     * Also reads back the 0x95 Lab so callers can sanity-check the result: a valid
     * white-reference calibration should read near-white/neutral. With the cap off
     * the device still ACKs, so validity must be judged from these values.
     */
    async calibrate() {
        // The calibrate ACK is authoritative: `c4 92 <status>` — status 0x01 = the
        // white reference was read successfully, 0x00 = failure (cap off / no chip).
        // Verified against cap-on (01) vs cap-off (00) captures.
        const ack = await this.transact(CMD_CALIBRATE);
        const status = ack[0] === 0xc4 && ack[1] === 0x92 ? ack[2] : -1;
        const ok = status === 0x01;
        // 0x95 Lab read is best-effort (device may return a stale value on failure).
        let lab = null;
        try {
            lab = decodeCalLab(await this.transact(CMD_READ_CAL_LAB, 2500));
        }
        catch {
            /* no Lab returned */
        }
        await this.waitSlotReady();
        const measurement = decodeMeasurement(await this.transact(CMD_READ_MEAS));
        return { ok, status, measurement, lab };
    }
    /** MATCH — request color match data (Lab floats + measurement frame). */
    async requestMatch() {
        await this.transact(CMD_MATCH); // c4 92 01 ack
        const calibrationLab = decodeCalLab(await this.transact(CMD_READ_CAL_LAB));
        await this.waitSlotReady();
        const measurement = decodeMeasurement(await this.transact(CMD_READ_MEAS));
        return { measurement, calibrationLab };
    }
    /**
     * Scan a sample and return its CIELAB (L*, a*, b*) — the single value the match
     * UI ranks against, from the 0x95 Lab read. Confirmed to be the measured
     * sample's color across extensive real-device testing on varied targets.
     */
    async scan() {
        const { calibrationLab, measurement } = await this.requestMatch();
        return {
            lab: { L: calibrationLab.Lstar, a: calibrationLab.astar, b: calibrationLab.bstar },
            raw: calibrationLab,
            measurement,
        };
    }
    async deviceInfo() {
        return decodeDeviceInfo(await this.transact(CMD_DEVICE_INFO));
    }
    async status() {
        return decodeStatus(await this.transact(CMD_GET_STATUS));
    }
}
