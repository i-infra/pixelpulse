# Pixelpulse

A web interface for the **Analog Devices ADALM1000 (M1K)** and **Nonolith CEE**
source-measure units: live streaming plots with analog-style phosphor density
rendering, waveform sourcing, triggering, measurements, and device calibration —
all in the browser.

Pixelpulse is a static web app with two interchangeable device backends:

- **WebUSB** (default in Chromium-based browsers): in-browser device
  drivers — plug in the device, click "Connect USB device…", done. No
  install, no daemon.
- **WebSocket**: the [nonolith-connect](https://github.com/nonolith/connect)
  daemon (with M1K support) on `localhost:9003` — for multi-client sharing,
  remote (LAN) operation, and non-WebUSB browsers. Force it with `#connect`
  (or `?server=host:port`); browsers permit `ws://localhost` connections
  even from `https://` origins, so this works from GitHub Pages too.

## Features

- **Live streaming plots** of voltage and current for both channels, with
  pan/zoom, X-Y mode side graphs, and CSV export
- **Phosphor density rendering** (default): every sample is deposited into a
  density accumulator exactly once, so trace brightness is a true sample
  count — noise renders as an honest confidence band, dwell shows as
  intensity grading, like an analog scope. Scrolls in real time; triggered
  sweeps accumulate with wall-clock persistence
- **Runs entirely in the browser** via WebUSB, or against the
  nonolith-connect daemon over a binary WebSocket protocol (raw float32
  frames, not JSON)
- **Signal sourcing**: constant, sine, triangle, square with on-graph drag
  handles for offset, amplitude, and period
- **Output-phase triggering** aligned to the observed waveform within a sample
- **Live stats** (RMS, mean, min, max) over the visible window, plus
  resistance/impedance readout (|Z| from AC RMS for waveform sources)
- **Guided M1K calibration wizard** (`m1k_calibrate.html`): implements the
  [ADI rev-D calibration procedure](https://wiki.analog.com/university/tools/m1k-calibration)
  with the voltage steps fully automated via the onboard input switches —
  one DMM reading of the 2.5 V rail and one precision resistor are the only
  external requirements; writes the device EEPROM through the dataserver
- **M1K advanced page** (`m1k_advanced.html`): power/temperature monitoring,
  analog frontend switch control, LEDs, calibration table
- Bode plot, curve tracer, firmware update, and debug pages

## Quick start

In a Chromium-based browser, open the hosted app, plug in the device, and
click **Connect USB device…** — that's it.

For development, or to use the WebSocket backend:

```sh
npm install
npm run dev        # development server on http://localhost:8000
```

then open `pixelpulse.html` (append `#connect` to use a running
nonolith-connect daemon instead of WebUSB).

## Pages

| Page | Purpose |
|------|---------|
| `pixelpulse.html` | Main instrument UI |
| `m1k_calibrate.html` | Guided M1K calibration wizard |
| `m1k_advanced.html` | M1K hardware monitoring & frontend control |
| `bodeplot.html` | Bode plot (frequency response) |
| `curvetrace.html` | I-V curve tracer |
| `calibrate.html` | Legacy CEE calibration |
| `fwupdate.html` | Device firmware update |
| `debuginfo.html` | Protocol/debug info |

## Development

TypeScript + Vite, no UI framework. Multi-page build — each HTML file in
`src/` is an entry point (registered in `vite.config.ts`).

```sh
npm run dev      # dev server with HMR
npm run build    # type-check + production build to dist/
npm run preview  # serve the production build
```

The WebSocket protocol (including the binary stream-update frame format) is
documented in the connect repository's `WS_API.md`.

## Deploying

Pushes to `main` deploy automatically to GitHub Pages via
`.github/workflows/deploy.yml` (set the repository's Pages source to
"GitHub Actions"). The build uses relative asset paths, so it works from any
mount point.

## History

Pixelpulse was created by [Nonolith Labs](http://nonolithlabs.com)
(Kevin Mehall) as the CoffeeScript web UI for the CEE. This is a modernized
relaunch by [@i-infra](https://github.com/i-infra): ported to
TypeScript/Vite, with ADALM1000 support, in-browser WebUSB drivers, binary
streaming, phosphor density rendering, and guided M1K calibration.

## License

GPL-3.0-or-later — see [LICENSE](LICENSE).

(C) 2011 Nonolith Labs, LLC ·
(C) 2026 [@i-infra](https://github.com/i-infra) and contributors.
