# Datacolor ColorReader — BLE Protocol Reverse-Engineering Report

**Date:** 2026-09-01 · **Source:** Apple PacketLogger captures + vendor BRSP spec
**Captures:** `ppg_colorreader_btle_confirmed.pklg` (557 KB, 7 558 recs) · `ppg_colorreader_btle_calibrate.pklg` (51 KB, 694 recs)
**Tooling:** `colorreader_brsp.py` (decoder, verified against both captures)

---

## 1. PacketLogger container format (reverse-engineered)

Apple PacketLogger v2 (the `.pklg` files here are **not** btsnoop):

```
record := length:u32 (LE, bytes of body) + body
body   := timestamp:8 + direction:u8 + payload
```

* `length` counts timestamp+direction+payload (no header, no trailing byte).
* `direction`: `0x02` = host→controller (ATT writes), `0x03` = controller→host (ATT indications),
  `0xFC/0xFD` = metadata strings, `0x01` = internal adv/log records, `0x0A` = vendor link stats.
* Inside `direction 0x01` records: `FF + len:u8 + sub-packet(len)` where the sub-packet is an
  Apple-internal HCI framing (`0e 0a` = LE advertising/scan report). These carry **advertising**
  data only — the ColorReader's GATT payloads live in `0x02/0x03`.

## 2. Transport layer (confirms the spec)

| Item | Value |
|---|---|
| GATT service | `DA2B84F1-6279-48DE-BDC0-AFBEA0226079` (BlueRadios BRSP UART) |
| Host → device | **Write Request**, ATT handle `0x001A` (`BF03260C-…-C299D159`) |
| Device → host | **Indication**, ATT handle `0x001C` (`18CDA784-…-91EC86AF`) |
| Indications enable | CCCD `0x001D` ← `0x0002` (disabled at capture end with `0x0000`) |
| Session open | write `0x0001` → handle `0x0022` (BRSP UART open; before first command) |
| Extra config | write `0x01` → handle `0x0018` ×2 (observed during handshake) |

Observed connection: device name `Model Y`, manufacturer data `42 4c 4e 43 …` (`BLNC`),
service UUID `0xFDA5`, MAC of iPhone tester `34:10:BE:F0:51:43`, app host iOS 26.6.

## 3. BRSP framing (confirms spec, with corrections)

* Logical message = `0x02 (STX)` + nibble-encoded payload+checksum + `0x03 (ETX)`.
* Nibble encoding: wire char = nibble + `0x30` → `'0'–'9' : ; < = > ?`. High nibble first.
* Checksum: last decoded byte = `sum(previous decoded bytes) & 0xFF`. **Verified on all 22 messages.**
* Fragmentation: one logical message arrives across several ~60 ms-spaced indications;
  STX/ETX delimit the *whole* message (fragments are raw continuation chunks).
* ⚠️ Spec correction: the device does **not** echo `0xC5` only for info — response headers are
  `C4` (ACK/echo), `C5` (device info), `C2` (status), `00 93` (measurement success).

## 4. Complete decoded transcript

### 4.1 `confirmed` capture (device-info → status → slot → measurement → cal-read → measurement)

| # | Dir | Decoded | Meaning |
|---|-----|---------|---------|
| 1 | → | `80 04 84` | Get device info |
| 2 | ← | `c5 01 01 00 01 00···00 39 30 30 31 34 31 37 35 39 00···9c` | Info: ASCII serial **"900141759"** @ offset 12, 80-byte struct |
| 3 | → | `80 01 81` | Get status |
| 4 | ← | `c2 33 2e 33 33 00···00 30 30 30 30 30 30 30 30 34 00 3d` | Status: FW string **"3.33"**, "00000004" ASCII |
| 5 | → | `80 09 89` | Check data slot |
| 6 | ← | `c4 80 01 00 00 00 01 46` | Ready; `0x0146` = 326 ⇒ 44-byte frame in buffer |
| 7 | → | `93 ff 92` | Read measurement buffer |
| 8 | ← | `00 93 f8 4a 43 6a 00 00 00 7a 7a 00 c8 35 00 00 00 00 7d 7c 00 40 ac 00 00 00 00 66 31 00 93 91 01 00 00 00 28 60 00 71 c1 01 01 d0` | **Measurement frame** (44 B) |
| 9 | → | `92 00 e7 54 43 6a 7a` | Calibration sub-command (query class) |
| 10 | ← | `c4 92 01 57` | ACK: opcode 92, status 01 = OK |
| 11 | → | `95 00 95` | **Read calibration CIELab** |
| 12 | ← | `c4 95 f8 4a 43 6a 72 ed bb 42 ce 86 6c 3d 0a 77 9f 3f 01 01` | **Lab = L* 93.964, a* 0.058, b* 1.246** (3× float32 LE) |
| 13 | → | `80 09 89` | Check data slot |
| 14 | ← | `c4 80 01 00 00 00 01 46` | Ready |
| 15 | → | `93 ff 92` | Read measurement buffer |
| 16 | ← | *(same 44-byte frame as #8)* | unchanged |

### 4.2 `calibrate` capture (the calibration button press)

| # | Dir | Decoded | Meaning |
|---|-----|---------|---------|
| 1 | → | `92 ff 88 59 43 6a 1f` | **Trigger** calibration/re-measure (`92 ff` class) |
| 2 | ← | `c4 92 01 57` | ACK accepted |
| 3 | → | `80 09 89` | Poll data slot |
| 4 | ← | `c4 80 01 00 00 00 01 46` | New frame ready |
| 5 | → | `93 ff 92` | Read measurement buffer |
| 6 | ← | `00 93 88 59 43 6a 00 00 00 7a 79 00 45 fc 00 00 00 00 7c 7c 00 b5 6f 00 00 00 00 66 32 00 0a 07 01 00 00 00 28 61 00 5d 19 01 01 1c` | **Fresh measurement frame** — integrator state changed |

## 5. Measurement frame (`00 93 …`, 44 bytes) — cross-capture diff

```
off  calibrate  confirmed  interpretation
 0     00         00        status (OK)
 1     93         93        echo opcode
 2     88         f8        ADC scan count (dim vs saturated-on-white)
 3     59         4a        ↑ mirrors byte 3 of 0x95 response (f8 4a here)
 4-5   43 6a      43 6a     device/session tag 'Cj' (constant)
 6-9   00 00 00 7a (both)   counter 0x7a = 122
10-13  79 00 45 fc | 7a 00 c8 35   chroma/integrator raw (BE u16: 0xfc45=-955 vs 0x35c8=13768)
14-17  00×4      00×4       reserved
18-19  7c 7c      7d 7c     flags
20-23  00 b5 6f 00 | 00 40 ac 00  spectral sample A (BE u16: 46447 vs 16556)
24-26  00 00 00   00 00 00   reserved
27-28  66 32      66 31      ASCII 'f2' vs 'f1' (scale/standard slot id)
29-31  0a 07 01   93 91 01   scale tag (0x0a07 vs 0x9391)
32-33  01 00      01 00      fixed
34-36  00 00 28   00 00 28   type byte 0x28 = 40
37     61         60         integration/gain index (changed after recalibration!)
38-42  00 5d 19 01 01  00 71 c1 01 01  tail
43     1c         d0         additive checksum ✓
```

⚠️ **Spec correction:** the vendor-spec layout (status + echo + 32 B spectral + 6 B Lab) does **not**
match the observed frames. The 44-byte frame is a tagged register dump, not a flat 16×u16 spectrum;
the CIELab is **not** inside the `0x93` frame — it is read via `0x95`.

## 6. CIELab recovery (the goal)

The calibrated colorimetry comes from **`95 00` → `c4 95 …`**:

```
c4 95 | f8 4a 43 6a | 72 ed bb 42 | ce 86 6c 3d | 0a 77 9f 3f | 01 01
 echo   id/tag 'Cj'   L* float32-LE  a* float32-LE  b* float32-LE  trailer
```

`72 ed bb 42` = 93.96376 · `ce 86 6c 3d` = 0.05775 · `0a 77 9f 3f` = 1.24582
→ L* 93.96, a* +0.06, b* +1.25 — a textbook white calibration tile reading.

## 7. Host driver recipe (open-source app / Web Bluetooth)

```
1. connect()
2. writeCharacteristic(0x001D, 0x0002)      # indications on
3. writeCharacteristic(0x0022, 0x0001)      # BRSP session open
4. writeCharacteristic(0x0018, 0x01)        # device config (as app does, ×2)
5. writeCharacteristic(0x001A, frame(bytes([0x80,0x04])))   # "800484" device info
6. loop: collect indications(0x001C) until STX..ETX complete
         nibble-decode, verify checksum, dispatch by opcode
7. measure cycle:
      frame(92 ff 88 59 43 6a)   # trigger (token bytes may be session-tied — verify)
      poll frame([0x80,0x09]) until 01 46 (44-byte frame ready)
      frame([0x93,0xff])         # read measurement frame
      frame([0x95,0x00])         # read CIELab floats (3× float32 LE @ offset 6)
```

Python implementation: **`/opt/data/colorreader/colorreader_brsp.py`**
(`frame()`, `nibdec()/nibenc()`, `parse_stream()`, `brsp_messages()`, `.pklg` parser + CLI decoder).

## 8. Open items / next captures needed

1. `92`-command token bytes (`e7 54` / `88 59`) — constant per session or rolling? Need ≥2 sessions.
2. Full 16-band spectral decode — need captures on **colored** targets (red/green/blue tiles) to
   map offsets 20-31 to wavelengths; white-vs-white only exposed 2 changing words.
3. Lab of *measured sample* vs calibration reference: confirm whether the app computes Lab host-side
   from the `0x93` frame or issues another `0x95`-class read after a sample measurement.
4. `0x0018` / `0x0022` GATT writes: confirm whether omitting them still works with bleak.
