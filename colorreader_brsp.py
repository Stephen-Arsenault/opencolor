#!/usr/bin/env python3
"""
Datacolor ColorReader (PCE-1 / "Model Y") BLE protocol — decoder & host reference.

Derived from Apple PacketLogger captures + vendor BRSP spec (2026-09-01).

TRANSPORT
  GATT Service : DA2B84F1-6279-48DE-BDC0-AFBEA0226079 (BlueRadios BRSP UART)
  TX (host->dev)  : Write Request,   handle 0x001A  (BF03260C-7205-4C25-AF43-93B1C299D159)
  RX (dev->host)  : Indication,      handle 0x001C  (18CDA784-4BD3-4370-85BB-BFED91EC86AF)
  Indications on  : CCCD handle 0x001D, value 0x0002
  Extra control   : handle 0x0022 value 0x0001 (BRSP "mode/UART-open"), observed before first command
                    handle 0x0018 value 0x01    (twice; likely device status config)

FRAMING (inside the GATT value, one logical message may span several indications)
  0x02 (STX) + ASCII(nibble-encoded bytes) + 0x03 (ETX)
  wire char = nibble + 0x30  ('0'..'9', ':',';','<','=','>','?')
  checksum  = last decoded byte == (sum of preceding decoded bytes) & 0xFF
  Fragment indication ≈60 ms apart; STX/ETX bracket the whole logical message.

COMMANDS (decoded payloads; wire = STX + enc + ETX)
  Get device info : 80 04 (+cks 84)  -> C5 + 80-byte struct, ASCII serial at offset 12
  Get status      : 80 01 (+cks 81)  -> C2 33 2E 33 33 ... ("3.33" FW string, state bytes)
  Get data slot   : 80 09 (+cks 89)  -> C4 80 01 00 00 00 01 46   (0x0146 = 326 -> 44-byte frame follows)
  Read measurement: 93 FF (+cks 92)  -> 00 93 + 42 bytes (see MEASUREMENT below)
  Trigger calib   : 92 00 E7 <target-id:2> (+cks)  -> C4 92 01 xx (accept)  [target 0x5443 'CT' = white tile]
  Read calibration: 95 00 (+cks 95)  -> C4 95 <adc2> <4B id> L*:f32 a*:f32 b*:f32 01 01
                                       floats little-endian, CIELab of active calibration target
  Echo/ACK        : C4 <cmd-byte> ... / C5 (info) / C2 (status)

MEASUREMENT FRAME (00 93 ... 44 bytes total)
  [0]      status (0x00 = OK)
  [1]      echo 0x93
  [2]      ADC count of scan (0x88 dim / 0xf8 saturated white)
  [3..9]   tag/state (bytes 43,6a = device id bytes; 7a/7a = count)
  [10..13] integrator/chroma raw (BE u16 0xfc45 vs 0x35c8 differ w/ target)
  [18..19] 0x7c7c / 0x7d7c flags
  [21..22] spectral sample A (BE u16 0xb56f=46447 vs 0x40ac=16556)
  [27..28] 'f','1'/'f','2' (0x66 0x31/32)
  [29..31] scale tag (0a 07 vs 93 91)
  [32..33] 01 00
  [34..37] 00 00 28 60/61   (0x28 = 40 = measurement type byte?)
  [38]     integration index 0x60=96 / 0x61=97
  [39..42] checksum tail (last byte = checksum)

  The 0x95 response carries the calibrated CIELab as three IEEE-754 LE floats:
      L* = 93.9638  a* = 0.0577  b* = 1.2458   (white calibration tile)

USAGE (host, e.g. Python + bleak):
  1. connect, enable indications (0x0002 -> CCCD 0x001D)
  2. write 0x0001 -> handle 0x0022 (open BRSP session)
  3. write b'\x02\x38\x30\x30\x34\x38\x34\x03'  ("800484")    -> device info
  4. write b'\x02\x38\x30\x30\x31\x38\x31\x03'  ("800181")    -> status
  5. write b'\x02\x38\x30\x30\x39\x38\x39\x03'  ("800989")    -> slot check
  6. write b'\x02\x39\x33\x3f\x3f\x39\x32\x03'  ("93??92")    -> measurement
  Reassemble indications until STX..ETX complete, nibble-decode, verify checksum.

Capture used: ppg_colorreader_btle_confirmed.pklg (557 KB, 7558 recs)
              ppg_colorreader_btle_calibrate.pklg  (51 KB,   694 recs)
"""
import sys

_DEC = {c: i for i in range(16) for c in [i + 0x30]}
STX, ETX = 0x02, 0x03


def nibdec(b: bytes):
    """wire ASCII -> raw bytes (spec: char = nibble + 0x30)"""
    out = bytearray()
    for i in range(0, len(b) - 1, 2):
        hi = _DEC.get(b[i]); lo = _DEC.get(b[i + 1])
        if hi is None or lo is None:
            return None, i
        out.append(hi << 4 | lo)
    return bytes(out), None


def nibenc(b: bytes) -> bytes:
    """raw bytes -> wire ASCII"""
    return bytes(n + 0x30 for n in b for n in (n >> 4, n & 0xF))


def frame(payload: bytes) -> bytes:
    """STX + encoded + ETX, appending additive checksum"""
    body = payload + bytes([sum(payload) & 0xFF])
    return bytes([STX]) + nibenc(body) + bytes([ETX])


def parse_stream(data: bytes):
    """split a BRSP byte stream into (wire, decoded, checksum_ok) logical messages"""
    msgs, i = [], 0
    while i < len(data):
        if data[i] == STX:
            j = data.find(bytes([ETX]), i)
            if j < 0:
                break
            w = data[i + 1:j]
            dec, err = nibdec(w)
            ok = dec is not None and (sum(dec[:-1]) & 0xFF) == dec[-1]
            msgs.append((w, dec, ok))
            i = j + 1
        else:
            i += 1
    return msgs


def parse_pklg(path):
    """Apple PacketLogger v2 container -> (dir, payload) records"""
    data = open(path, "rb").read()
    off, recs = 0, []
    while off + 4 <= len(data):
        rlen = int.from_bytes(data[off:off + 4], "little")
        if rlen < 9 or off + 4 + rlen > len(data):
            break
        d = data[off + 12]
        payload = data[off + 13:off + 4 + rlen]
        recs.append((d, payload))
        off += 4 + rlen
    return recs


def brsp_messages(path):
    """extract ordered host<->device BRSP logical messages from a .pklg"""
    recs = parse_pklg(path)
    events = []
    for idx, (d, p) in enumerate(recs):
        if d == 0x02:  # host -> controller (ACL TX): ATT Write Req 12 1a 00 val
            k = p.find(b"\x12\x1a\x00")
            if k >= 0:
                events.append((idx, "W", p[k + 3:]))
        elif d == 0x03:  # controller -> host: ATT Handle Value Indication 1d 1c 00 val
            k = p.find(b"\x1d\x1c\x00")
            if k >= 0:
                events.append((idx, "I", p[k + 3:]))
    cur = {"W": bytearray(), "I": bytearray()}
    out = []
    for idx, k, v in events:
        cur[k].extend(v)
        b = bytes(cur[k]); i = 0
        while i < len(b):
            if b[i] == STX:
                j = b.find(bytes([ETX]), i)
                if j < 0:
                    break
                out.append((idx, k, b[i + 1:j]))
                i = j + 1
            else:
                i += 1
        cur[k] = bytearray(b[i:])
    return out


if __name__ == "__main__":
    for path in sys.argv[1:]:
        print(f"=== {path} ===")
        for idx, k, wire in brsp_messages(path):
            dec, err = nibdec(wire)
            arrow = ">>" if k == "W" else "<<"
            ok = dec is not None and (sum(dec[:-1]) & 0xFF) == dec[-1]
            print(f"rec#{idx:<5d} {arrow} wire={wire.decode('ascii', 'replace')}")
            print(f"            hex={dec.hex(' ') if dec else 'ERR@' + str(err)}"
                  f"  cks={'OK' if ok else 'BAD'}")
