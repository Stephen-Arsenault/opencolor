#!/usr/bin/env python3
"""
Datacolor ColorReader (PCE-1 / "Model Y") — full-cycle BLE demo driver.

Cycle (every --interval seconds, default 5):
    1. PAIR / CONNECT   BLE connect + GATT discovery + BRSP session open
    2. INFO             read device identity (serial, FW)
    3. STATUS           read device status
    4. MATCH            request color match data (trigger → poll slot →
                        read 44-byte measurement frame → read CIELab floats)
    5. DISCONNECT       clean BRSP close + BLE disconnect

Protocol (reverse-engineered from Apple PacketLogger captures, 2026-09-01):

  GATT service   DA2B84F1-6279-48DE-BDC0-AFBEA0226079   (BlueRadios BRSP UART)
    char 0x0016  99564A02-DC01-4D3C-B04E-3BB1EF0571B2   (read-only, unused here)
    char 0x0018  A87988B9-694C-479C-900E-95DFA6C00A24   (write; app writes 0x01)
    char 0x001A  BF03260C-7205-4C25-AF43-93B1C299D159   (host -> device, Write Request)
    char 0x001C  18CDA784-4BD3-4370-85BB-BFED91EC86AF   (device -> host, Indications)
      CCCD 0x001D / 0x2902 <- 0x0002 to enable
    char 0x001F  0A1934F5-24B8-4F13-9842-37BB167C6AFF   (notify, unused)
    char 0x0021  FDD6B4D3-046D-4330-BDEC-1FD0C90CB43B   (write+notify, unused)
    char 0x0022  (inside service, written 0x0001 to open the BRSP session)

  BRSP frame   0x02 + ASCII(nibble+0x30 of payload+checksum) + 0x03
  Checksum     last byte = sum(previous bytes) & 0xFF
  Commands     80 04  -> C5 + 80B info (ASCII serial @12)
               80 01  -> C2 "3.33" FW/status
               80 09  -> C4 80 01 00 00 00 01 46   (0x0146 => 44B frame ready)
               93 FF  -> 00 93 + 42B measurement frame
               92 ..  -> C4 92 01 .. (calibration trigger/ack)
               95 00  -> C4 95 <adc><id> <L* f32le> <a* f32le> <b* f32le> 01 01

Usage:
    python3 colorreader_demo.py                 # auto-detect by name "ColorReader"/"Model Y"
    python3 colorreader_demo.py --address XX:XX:XX:XX:XX:XX
    python3 colorreader_demo.py --interval 10 --cycles 3

Requirements:
    pip install bleak          (Linux needs BlueZ; macOS/Windows OK)
    Device must be awake — press its button if the scan finds nothing.
"""

import argparse
import asyncio
import contextlib
import struct
import sys
import time

try:
    from bleak import BleakClient, BleakScanner
except ImportError:
    sys.exit("bleak not installed — run:  pip install bleak  (needs BlueZ on Linux)")

# --------------------------------------------------------------------------- #
# GATT constants
# --------------------------------------------------------------------------- #
SVC_BRSP      = "da2b84f1-6279-48de-bdc0-afbea0226079"
CH_BRSP_TX    = "bf03260c-7205-4c25-af43-93b1c299d159"   # write host->dev  (0x001A)
CH_BRSP_RX    = "18cda784-4bd3-4370-85bb-bfed91ec86af"   # indicate dev->host (0x001C)
CH_BRSP_CFG   = "a87988b9-694c-479c-900e-95dfa6c00a24"   # app writes 0x01  (0x0018)
CH_BRSP_MODE  = CH_BRSP_CFG                              # alias
CCCDescriptor = "00002902-0000-1000-8000-00805f9b34fb"

DEVICE_NAME_FILTERS = ("colorreader", "model y", "datacolor", "ppg")

STX, ETX = 0x02, 0x03
_DEC = {c: i for i in range(16) for c in [i + 0x30]}


# --------------------------------------------------------------------------- #
# BRSP codec
# --------------------------------------------------------------------------- #
def nibenc(b: bytes) -> bytes:
    return bytes(n + 0x30 for n in b for n in (n >> 4, n & 0xF))


def nibdec(b: bytes):
    out = bytearray()
    for i in range(0, len(b) - 1, 2):
        hi, lo = _DEC.get(b[i]), _DEC.get(b[i + 1])
        if hi is None or lo is None:
            return None, i
        out.append(hi << 4 | lo)
    return bytes(out), None


def frame(payload: bytes) -> bytes:
    """STX + nibble-encoded(payload + additive checksum) + ETX"""
    return bytes([STX]) + nibenc(payload + bytes([sum(payload) & 0xFF])) + bytes([ETX])


class BrspStream:
    """Accumulates indication fragments; yields complete decoded messages."""

    def __init__(self):
        self._buf = bytearray()

    def feed(self, data: bytes):
        self._buf.extend(data)
        done = []
        i = 0
        while i < len(self._buf):
            if self._buf[i] == STX:
                j = self._buf.find(bytes([ETX]), i)
                if j < 0:
                    break
                wire = self._buf[i + 1:j]
                dec, err = nibdec(wire)
                if dec is not None and (sum(dec[:-1]) & 0xFF) == dec[-1]:
                    done.append(dec)
                else:
                    print(f"  [brsp] bad frame: {wire!r} (err@{err})")
                i = j + 1
            else:
                i += 1                      # stray byte (fragment gap) — resync
        if i:
            del self._buf[:i]
        return done


# --------------------------------------------------------------------------- #
# Command payloads (decoded bytes; frame() wraps them for the wire)
# --------------------------------------------------------------------------- #
CMD_DEVICE_INFO   = bytes([0x80, 0x04])
CMD_GET_STATUS    = bytes([0x80, 0x01])
CMD_CHECK_SLOT    = bytes([0x80, 0x09])
CMD_READ_MEAS     = bytes([0x93, 0xFF])
CMD_READ_CAL_LAB  = bytes([0x95, 0x00])
# Two distinct 92-class operations observed across the captures:
#   CALIBRATE (ppg_colorreader_btle_calibrate.pklg):  92 FF 88 59 43 6A -> ack,
#       poll slot, read 93 FF  — new frame carries the check against the
#       known white reference (integrator/spectral values changed).
#   MATCH (ppg_colorreader_btle_confirmed.pklg):      92 00 E7 54 43 6A -> ack,
#       read 95 00 Lab floats, poll slot, read 93 FF.
# Token bytes were identical across sessions; if the device NAKs, verify against
# a fresh capture.
CMD_CALIBRATE     = bytes([0x92, 0xFF, 0x88, 0x59, 0x43, 0x6A])
CMD_MATCH         = bytes([0x92, 0x00, 0xE7, 0x54, 0x43, 0x6A])


# --------------------------------------------------------------------------- #
# Response decoders
# --------------------------------------------------------------------------- #
def decode_device_info(dec: bytes) -> dict:
    if dec[0] != 0xC5:
        return {"raw": dec.hex(" ")}
    serial = dec[12:22].split(b"\x00")[0].decode("ascii", "replace")
    return {"header": "C5", "serial": serial, "raw_len": len(dec)}


def decode_status(dec: bytes) -> dict:
    if dec[0] != 0xC2:
        return {"raw": dec.hex(" ")}
    fw = dec[1:6].split(b"\x00")[0].decode("ascii", "replace")
    state = dec[12:22].split(b"\x00")[0].decode("ascii", "replace")
    return {"header": "C2", "fw": fw, "state": state}


def decode_slot(dec: bytes) -> dict:
    if dec[0] != 0xC4:
        return {"raw": dec.hex(" ")}
    words = [int.from_bytes(dec[i:i + 2], "big") for i in (4, 6)]
    return {"header": "C4", "slot_ready": words[1] == 0x0146,
            "frame_len": 44 if words[1] == 0x0146 else words[1]}


def decode_measurement(dec: bytes) -> dict:
    if dec[0] != 0x00 or dec[1] != 0x93:
        return {"raw": dec.hex(" ")}
    return {
        "status": dec[0],
        "adc_scan": dec[2],
        "tag": dec[3:10].hex(" "),
        "integrator_be16": struct.unpack(">h", dec[12:14])[0],
        "spectral_a_be16": struct.unpack(">H", dec[21:23])[0],
        "standard_slot": dec[27:29].decode("ascii", "replace"),
        "gain_index": dec[37],
    }


def decode_cal_lab(dec: bytes) -> dict:
    if dec[0] != 0xC4 or dec[1] != 0x95:
        return {"raw": dec.hex(" ")}
    L, a, b = struct.unpack_from("<fff", dec, 6)
    return {"adc": dec[2], "id": dec[3:6].hex(" "),
            "L*": round(L, 3), "a*": round(a, 3), "b*": round(b, 3)}


# --------------------------------------------------------------------------- #
# Device driver
# --------------------------------------------------------------------------- #
class ColorReader:
    def __init__(self, address: str = None, timeout: float = 15.0):
        self.address = address
        self.timeout = timeout
        self.client = None
        self.stream = BrspStream()
        self._rx_queue: asyncio.Queue = asyncio.Queue()

    # ---- BLE plumbing ----------------------------------------------------- #
    def _on_indication(self, _char, data: bytearray):
        for msg in self.stream.feed(bytes(data)):
            self._rx_queue.put_nowait(msg)

    async def connect(self):
        if self.address:
            dev = await BleakScanner.find_device_by_address(self.address, timeout=self.timeout)
            adv = None
        else:
            print("  scanning…")
            found = await BleakScanner.discover(timeout=5.0, return_adv=True)
            match = next(((d, adv) for d, adv in found.values()
                          if d.name and any(f in d.name.lower() for f in DEVICE_NAME_FILTERS)),
                         (None, None))
            dev, adv = match
            if dev is None:   # last resort: match by advertised 128-bit service UUID
                dev, adv = next(((d, adv) for d, adv in found.values()
                                 if SVC_BRSP in (adv.service_uuids or [])),
                                (None, None))
        if dev is None:
            raise TimeoutError("ColorReader not found — is it awake? (press its button)")
        rssi = getattr(adv, "rssi", None) if adv else None
        print(f"  found {dev.name!r} [{dev.address}]  rssi={rssi}")

        self.client = BleakClient(dev, timeout=self.timeout)
        await self.client.connect()
        print(f"  connected, mtu={self.client.mtu_size}")

        # 1) enable BRSP indications (CCCD <- 0x0002)
        await self.client.start_notify(CH_BRSP_RX, self._on_indication)
        # 2) BRSP session open (handle 0x0022 <- 0x0001)
        with contextlib.suppress(Exception):
            await self.client.write_gatt_char("fdd6b4d3-046d-4330-bdec-1fd0c90cb43b",
                                              b"\x01", response=True)
        # 3) the app also wrote 0x01 to 0x0018
        with contextlib.suppress(Exception):
            await self.client.write_gatt_char(CH_BRSP_CFG, b"\x01", response=True)
        await asyncio.sleep(0.2)

    async def disconnect(self):
        # clean BRSP close: 0x0000 to the RX characteristic's CCCD (observed at capture end);
        # stop_notify already clears it on most stacks — the raw write is belt & braces.
        with contextlib.suppress(Exception):
            await self.client.stop_notify(CH_BRSP_RX)
        with contextlib.suppress(Exception):
            cccd = await self._cccd_handle()
            if cccd is not None:
                await self.client.write_gatt_descriptor(cccd, b"\x00\x00")
        with contextlib.suppress(Exception):
            await self.client.disconnect()

    async def _cccd_handle(self):
        for s in self.client.services:
            for c in s.characteristics:
                if c.uuid == CH_BRSP_RX:
                    for d in c.descriptors:
                        if "2902" in d.uuid:
                            return d.handle
        return None

    # ---- BRSP request/response -------------------------------------------- #
    async def transact(self, payload: bytes, timeout: float = 6.0) -> bytes:
        """Send a command frame, return the first decoded response message."""
        while not self._rx_queue.empty():
            self._rx_queue.get_nowait()
        await self.client.write_gatt_char(CH_BRSP_TX, frame(payload), response=True)
        return await asyncio.wait_for(self._rx_queue.get(), timeout)

    async def wait_slot_ready(self, timeout: float = 20.0) -> bool:
        """Poll 80 09 until the device reports a 44-byte frame in the slot."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if decode_slot(await self.transact(CMD_CHECK_SLOT)).get("slot_ready"):
                return True
            await asyncio.sleep(0.3)
        return False

    # ---- high-level operations -------------------------------------------- #
    async def device_info(self) -> dict:
        return decode_device_info(await self.transact(CMD_DEVICE_INFO))

    async def status(self) -> dict:
        return decode_status(await self.transact(CMD_GET_STATUS))

    async def calibrate(self) -> dict:
        """CALIBRATE — measure against the known white reference.

        Sequence from ppg_colorreader_btle_calibrate.pklg:
            92 ff … -> c4 92 01 (ack), poll 80 09 until slot ready,
            read 93 ff -> fresh measurement frame (the calibration check).
        """
        await self.transact(CMD_CALIBRATE)                         # c4 92 01 …
        if not await self.wait_slot_ready():
            raise TimeoutError("data slot never became ready after calibration")
        return {"calibration_measurement": decode_measurement(
            await self.transact(CMD_READ_MEAS))}

    async def request_match(self) -> dict:
        """MATCH — request color match data.

        Sequence from ppg_colorreader_btle_confirmed.pklg:
            92 00 … -> c4 92 01 (ack), read 95 00 (Lab floats),
            poll 80 09, read 93 ff (measurement frame).
        """
        await self.transact(CMD_MATCH)                             # c4 92 01 …
        lab = decode_cal_lab(await self.transact(CMD_READ_CAL_LAB))
        if not await self.wait_slot_ready():
            raise TimeoutError("data slot never became ready")
        meas = decode_measurement(await self.transact(CMD_READ_MEAS))
        return {"measurement": meas, "calibration_lab": lab}


# --------------------------------------------------------------------------- #
# Demo cycle
# --------------------------------------------------------------------------- #
async def cycle(reader: ColorReader, n: int):
    print(f"\n──── cycle {n} @ {time.strftime('%H:%M:%S')} ────")

    print("[pair] connect + BRSP open")
    await reader.connect()

    try:
        print("[info]  ", await reader.device_info())
        print("[status]", await reader.status())

        print("[calibrate] measuring against white reference…")
        for k, v in (await reader.calibrate()).items():
            print(f"        {k}: {v}")

        print("[match] requesting color match data…")
        result = await reader.request_match()
        for k, v in result.items():
            print(f"        {k}: {v}")
    finally:
        print("[disconnect]")
        await reader.disconnect()


async def main():
    ap = argparse.ArgumentParser(description="Datacolor ColorReader full-cycle demo")
    ap.add_argument("--address", help="device MAC/UUID (default: scan by name)")
    ap.add_argument("--interval", type=float, default=5.0,
                    help="seconds between cycles (default 5)")
    ap.add_argument("--cycles", type=int, default=0,
                    help="stop after N cycles (0 = run forever)")
    args = ap.parse_args()

    n = 0
    while True:
        reader = ColorReader(args.address)
        try:
            await cycle(reader, n + 1)
        except Exception as exc:
            print(f"cycle failed: {exc!r}")
            with contextlib.suppress(Exception):
                await reader.disconnect()
        n += 1
        if args.cycles and n >= args.cycles:
            break
        await asyncio.sleep(args.interval)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nstopped")
