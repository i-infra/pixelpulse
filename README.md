# Pixelpulse

A web interface for the **Analog Devices ADALM1000 (M1K)** and **Nonolith CEE**
source-measure units: live streaming plots with analog-style phosphor density
rendering, waveform sourcing, triggering, measurements, and device calibration —
all in the browser.

Pixelpulse is a static web app. It talks to a small local dataserver
([nonolith-connect](https://github.com/nonolith/connect), with M1K support)
over a WebSocket on `localhost:9003`; the page itself can be served from
anywhere, including GitHub Pages — browsers permit `ws://localhost`
connections even from `https://` origins.

## Features

- **Live streaming plots** of voltage and current for both channels, with
  pan/zoom, X-Y mode side graphs, and CSV export
- **Phosphor density rendering** (default): every sample is deposited into a
  density accumulator exactly once, so trace brightness is a true sample
  count — noise renders as an honest confidence band, dwell shows as
  intensity grading, like an analog scope. Scrolls in real time; triggered
  sweeps accumulate with wall-clock persistence
- **Binary WebSocket streaming**: sample data moves as raw float32 frames,
  not JSON
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

1. Build and run the dataserver (see the connect repository); it serves
   `ws://localhost:9003` and needs exclusive USB access to the device
2. Serve this app:
   ```sh
   npm install
   npm run dev        # development server on http://localhost:8000
   ```
   or use a hosted build — the app runs entirely client-side
3. Open `pixelpulse.html`

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

Pushes to `master` deploy automatically to GitHub Pages via
`.github/workflows/deploy.yml` (set the repository's Pages source to
"GitHub Actions"). The build uses relative asset paths, so it works from any
mount point.

## History

Pixelpulse was created by [Nonolith Labs](http://nonolithlabs.com)
(Kevin Mehall) as the CoffeeScript web UI for the CEE. This is a modernized
relaunch: ported to TypeScript/Vite, with ADALM1000 support, binary
streaming, phosphor rendering, and in-browser M1K calibration.

## License

GPL-3.0-or-later — see [LICENSE](LICENSE).
(C) 2011 Nonolith Labs, LLC and contributors.
