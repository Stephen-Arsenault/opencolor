# ColorReader BLE - Datacolor PCE-1 / "Model Y" reverse engineering

Protocol decode, drivers, and tooling for controlling the Datacolor ColorReader
from a host computer (Python + Web Bluetooth), reverse-engineered from Apple
PacketLogger captures of the official Android app.

## Layout

- REVERSE_ENGINEERING_REPORT.md - full annotated transcript of both captures + protocol docs
- colorreader_brsp.py - standalone .pklg parser + BRSP decoder (capture analysis tool)
- colorreader_demo.py - bleak (Python) driver: pair > info > status > calibrate > match > disconnect
- web/ - TypeScript port for the Web Bluetooth API (Chrome/Edge) + demo page + replay tests

## Quick start

Python (desktop, BlueZ):

    python3 -m venv venv && ./venv/bin/pip install bleak
    ./venv/bin/python colorreader_demo.py            # auto-detect device
    ./venv/bin/python colorreader_demo.py --address XX:XX:XX:XX:XX:XX --interval 5

Web (Chrome/Edge, secure context required):

    cd web
    npm install
    npm run build          # tsc -> dist/
    npm test               # replays both .pklg captures through the TS codec
    npx serve .            # open in Chrome, click "Run full cycle"

## Protocol summary

- Transport: BLE GATT, BlueRadios BRSP UART service da2b84f1-6279-48de-bdc0-afbea0226079
- Write (host>dev): bf03260c-... (handle 0x001A)
- Indicate (dev>host): 18cda784-... (handle 0x001C), CCCD 0x2902
- Framing: STX 0x02 + nibble-encoded ASCII (+0x30/nibble) + additive checksum + ETX 0x03
- Calibrate (white-ref check): 92 ff 88 59 43 6a > ack > poll 80 09 until 0x0146 > read 93 ff
- Match (Lab read): 92 00 e7 54 43 6a > ack > read 95 00 -> 3x float32-LE CIELab
- Info: 80 04 (serial in C5 frame); Status: 80 01 (FW/state in C2 frame)

See REVERSE_ENGINEERING_REPORT.md for byte-level detail and open questions.
