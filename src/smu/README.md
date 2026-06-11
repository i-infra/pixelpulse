# smu — WebUSB drivers for CEE and ADALM1000 (M1K)

A self-contained TypeScript library that talks to Nonolith CEE and Analog
Devices ADALM1000 source-measure units directly from the browser over
WebUSB. It is a port of the device layer of the
[Nonolith Connect](https://github.com/nonolith/connect) daemon
(`cee.cpp`, `m1k.cpp`, `bootloader.cpp`, `streaming_device/`), with the
WebSocket/REST plumbing replaced by an in-process typed event API.

This directory has **no dependencies on the rest of Pixelpulse** — it can be
copied or packaged for use in any web application.

## Requirements

- A Chromium-based browser (Chrome, Edge, Opera). WebUSB is not available
  in Firefox or Safari.
- Page served over HTTPS or `localhost`.
- Windows: the device must be bound to WinUSB (e.g. via Zadig) — the same
  requirement Nonolith Connect had.
- Linux: udev rules granting the user read/write access to the device node.

## Quick start

```ts
import { SMUSession, M1KDevice, makeSource } from './smu';

const session = new SMUSession();
await session.start(); // reattach previously-granted devices

// From a click handler (WebUSB requires a user gesture for new devices):
const usbDev = await session.requestDevice();
if (!usbDev) throw new Error('no device chosen');

const dev = await session.open(usbDev); // CEEDevice | M1KDevice | BootloaderDevice

if (dev instanceof M1KDevice) {
  // 100 ksps, 1 s of history, continuous ring buffer, calibrated units
  await dev.configure(0, 1 / 100e3, 100000, true, false);

  // Source a 1 kHz 2.5 V ± 1 V sine on channel A (SVMI mode = 1)
  await dev.setOutput(dev.channelA, makeSource({
    mode: 1, source: 'sine', offset: 2.5, amplitude: 1,
    period: 1 / 1000 / dev.sampleTime,
  }));

  dev.data.subscribe(() => {
    // Newest sample index is dev.bufferMax() - 1; read measured values:
    const i = dev.bufferMax() - 1;
    const volts = dev.get(dev.channelAV, i);
    const milliamps = dev.get(dev.channelAI, i);
    console.log(volts, milliamps);
  });

  await dev.startCapture();
}
```

## Architecture

| Module | Origin in Connect | Purpose |
|---|---|---|
| `usb.ts` | `usb_device.hpp`, libusb transfer rings | `UsbTransport` (vendor control transfers), `InPump`/`OutPump` (N queued bulk transfers kept in flight) |
| `streaming-device.ts` | `streaming_device/streaming_device.{hpp,cpp}` | Capture state machine, `Stream` ring buffers, `Channel`, typed events |
| `output-source.ts` | `streaming_device/output_source.cpp` | Constant / sine / triangle / square / adv_square / arbitrary waveform synthesis |
| `cee.ts` | `cee/cee.{hpp,cpp}` | CEE driver: packet codecs, calibration, gain, GPIO, current limit |
| `m1k.ts` | `m1k/m1k.{hpp,cpp}` | M1K driver: SOF sync, modes, frontend switches, digipots, LEDs, power/temperature |
| `bootloader.ts` | `bootloader/bootloader.{hpp,cpp}` | Xmega bootloader: erase / write / CRC / reset (in-browser firmware update) |
| `session.ts` | `usb.cpp` hotplug | Device discovery, permission flow, connect/disconnect events |

The listener/decimation layer of Connect (`stream_listener.cpp`) is
deliberately **not** ported: it existed to ship reduced data over a socket.
In-process consumers subscribe to `StreamingDevice.data` and read the
sample ring buffers directly with `get()` / `resample()` /
`bufferMin()` / `bufferMax()`.

## Events

`StreamingDevice` exposes typed events replacing Connect's broadcast JSON
notifications:

- `configChanged` — channels/streams were reallocated (`configure()`)
- `captureStateChanged(running, done)` — start/pause/finish
- `captureReset` — capture time reset to 0
- `data` — new samples are in the stream buffers
- `outputChanged(channel, source)` — output source replaced or became effective
- `gainChanged(channel, stream, gain)`
- `packetDrop` — device reported a dropped packet (CEE)
- `error(e)` — unrecoverable streaming error (capture auto-pauses)
- `disconnected` — device unplugged

## Caveats

- One tab owns the device: WebUSB interface claims are exclusive. There is
  no multi-client sharing as Connect provided; use a SharedWorker if you
  need cross-tab access.
- Keep the page foregrounded during capture, or run capture from a worker:
  background-tab throttling does not stop USB completion callbacks, but
  heavy rendering work scheduled on rAF will starve.
- Firmware update: when a CEE re-enumerates as the bootloader (different
  PID), the browser treats it as a new device — one extra permission
  prompt per unit.
- WebUSB has no per-transfer timeout or cancellation; capture teardown
  aborts pending transfers by re-selecting the interface alternate setting.
