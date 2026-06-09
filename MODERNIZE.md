# Pixelpulse Modernization Plan

**Goal:** Port the Pixelpulse CoffeeScript frontend to TypeScript with a modern build toolchain, preserving the existing WebSocket protocol and multi-page architecture.

**Decisions made:**
- Backend: unchanged (Nonolith Connect WS server on localhost:9003)
- UI: vanilla TypeScript + DOM (no framework)
- Structure: multi-page (keep separate HTML entry points)
- Deployment: local + hosted (static files, no internet dependency for core function)

---

## Phase 0: Scaffold the build toolchain

Set up the modern project skeleton alongside the existing code so both can coexist during migration.

- [ ] `npm init` + install dev dependencies: `vite`, `typescript`, `less` (build-time)
- [ ] Create `tsconfig.json` with strict mode
- [ ] Create `vite.config.ts` with multi-page entry points (one per HTML page)
- [ ] Create `src/` directory for TypeScript source
- [ ] Verify `npm run dev` serves a blank page and `npm run build` produces `dist/`
- [ ] Add `.gitignore` entries for `node_modules/`, `dist/`

**Output:** working Vite dev server, no CoffeeScript ported yet.

---

## Phase 1: Core types and utilities (leaf modules, no dependencies)

Port the small, dependency-free modules first to establish the type foundation.

- [ ] **`src/human-units.ts`** from `human_units.coffee` (89 lines)
  - SI prefix formatting functions
  - Export typed utility functions

- [ ] **`src/export.ts`** from `export.coffee` (21 lines)
  - Blob/URL CSV download

- [ ] **`src/widgets.ts`** from `widgets.coffee` (87 lines)
  - Replace jQuery DOM construction with vanilla `document.createElement`

**Output:** typed utility modules, importable by everything else.

---

## Phase 2: WebSocket protocol layer

This is the most important module to type properly. The existing protocol uses implicit JSON message shapes -- TypeScript discriminated unions will make this robust.

- [ ] **`src/dataserver.ts`** from `dataserver.coffee` (527 lines)
  - Define interfaces for all WS message types (device list, stream data, output config, capture state, etc.)
  - Discriminated union on `_cmd` / `_action` fields
  - Typed `Event` emitter (replace custom Event class with typed wrapper around `EventTarget` or a small typed emitter)
  - `CEEDevice`, `Channel`, `Stream` as typed classes/interfaces
  - Replace `window.MozWebSocket` fallback with plain `WebSocket`
  - Preserve the callback-ID pattern for request/response, but type it

**Output:** `Dataserver`, `CEEDevice`, `Channel`, `Stream` types exported. All message shapes documented in types. This is the contract the rest of the app builds on.

---

## Phase 3: Canvas/WebGL rendering engine

The largest and most complex file. Port in sub-steps.

- [ ] **`src/livegraph.ts`** from `livegraph.coffee` (858 lines)
  - Port the core `GraphCanvas` class (Canvas2D + WebGL paths)
  - Replace `"experimental-webgl"` with `"webgl"`
  - Remove `requestAnimationFrame` polyfill (native everywhere)
  - Type the axis/transform system (`xaxis`, `yaxis`, mapping functions)
  - Type the action system (`DragScrollAction`, `ZoomXAction`, etc.) -- use a discriminated union or interface
  - Type the overlay system (`Dot`, `TriggerOverlay`, etc.)
  - Replace jQuery event binding with vanilla `addEventListener`

**Output:** typed rendering engine, no jQuery dependency.

---

## Phase 4: Data listener / streaming layer

- [ ] **`src/livegraph-data-listener.ts`** from `livegraph_data_listener.coffee` (415 lines)
  - Type the `DataListener` and `TimeseriesGraphListener` classes
  - Type the circular buffer (Float32Array backed)
  - Wire up to typed `Dataserver` and `GraphCanvas`

**Output:** typed data pipeline from WS messages to graph rendering.

---

## Phase 5: Session management

- [ ] **`src/session.ts`** from `session_common.coffee` (129 lines)
  - Device selection, connection state, error overlays
  - Replace jQuery DOM manipulation with vanilla
  - Use typed `Dataserver` API

**Output:** session lifecycle management, fully typed.

---

## Phase 6: Main app - Pixelpulse oscilloscope

- [ ] **`src/views.ts`** from `views.coffee` (433 lines)
  - Channel/stream panels, output waveform controls, graph panels
  - Replace jQuery with vanilla DOM
  - Use typed device/channel/stream interfaces

- [ ] **`src/app.ts`** from `app.coffee` (47 lines)
  - Main entry point: layout management, toolbar, trigger, autozoom

- [ ] **`src/pixelpulse.html`** -- new HTML shell
  - Remove `<script type="text/coffeescript">` tags
  - Single `<script type="module" src="src/app.ts">` (Vite handles the rest)
  - Inline LESS replaced with built CSS

- [ ] **`src/ui.less`** from `ui.less`
  - Remove vendor-prefixed flexbox (`-webkit-box`, `-moz-box`) -> `display: flex`
  - Remove vendor-prefixed transitions
  - Keep LESS (Vite compiles it at build time), or convert to plain CSS

**Output:** fully working Pixelpulse oscilloscope page in TypeScript.

---

## Phase 7: Secondary apps

Port each secondary page. These are smaller and mostly self-contained.

- [ ] **`src/bodeplot.ts`** from `bodeplot.coffee` (304 lines) + `bodeplot.html`
  - Keep `dsp.js` for FFT (add `@types` or a `.d.ts` shim), or replace with a modern alternative
- [ ] **`src/curvetrace.ts`** from `curvetrace.coffee` (197 lines) + `curvetrace.html`
- [ ] **`src/fwupdate.ts`** from `fwupdate.coffee` (218 lines) + `fwupdate.html`
- [ ] **`src/calibrate.ts`** from `calibrate.coffee` (286 lines) + `calibrate.html`
  - Replace `async.js` with native `async/await` + `Promise`
- [ ] **`src/debuginfo.ts`** from `debuginfo.coffee` (72 lines) + `debuginfo.html`
- [ ] **`src/editsenseresistor.ts`** from `editsenseresistor.coffee` (116 lines) + `editsenseresistor.html`
- [ ] **`src/setup.html`** from `setup.html` (mostly static, minimal JS)

**Output:** all pages ported and working.

---

## Phase 8: Cleanup

- [ ] Remove `lib/` directory (coffee-script.js, jquery, less.js, async.js)
  - `dsp.js` either vendored as a typed module or replaced
- [ ] Remove all `.coffee` files
- [ ] Remove `ga-events.coffee` (drop Google Analytics, or replace with a modern analytics solution if wanted)
- [ ] Remove `calibration_server.coffee` (Node.js server-side script -- handle separately if still needed)
- [ ] Update `launch.sh` to point at the built output or dev server
- [ ] Update `.gitignore`
- [ ] Smoke-test all pages against a live device (or mock WS server)

---

## API modernization checklist (applied throughout)

| Old | New | Phase |
|-----|-----|-------|
| `<script type="text/coffeescript">` + browser compiler | Vite + `tsc` build step | 0 |
| jQuery 1.7.1 | `document.querySelector`, `addEventListener`, `classList` | 1-7 |
| `"experimental-webgl"` | `"webgl"` | 3 |
| `window.MozWebSocket` fallback | `WebSocket` (universal) | 2 |
| `requestAnimationFrame` polyfill | Native `requestAnimationFrame` | 3 |
| `_gaq.push()` classic GA | Remove or replace | 8 |
| `-webkit-box` / `-moz-box` flexbox | `display: flex` | 6 |
| LESS in-browser compilation | LESS at build time (Vite plugin) | 0 |
| `async.js` waterfall/series | `async/await` + `Promise` | 7 |
| Google Fonts over HTTP | Self-host or use `font-display: swap` over HTTPS | 6 |
| Global namespace (`window.server`, `window.livegraph`) | ES modules with `import`/`export` | all |

---

## File mapping

```
OLD (flat)                          NEW (src/)
human_units.coffee          ->      src/human-units.ts
export.coffee               ->      src/export.ts
widgets.coffee              ->      src/widgets.ts
dataserver.coffee           ->      src/dataserver.ts
livegraph.coffee            ->      src/livegraph.ts
livegraph_data_listener.coffee ->   src/livegraph-data-listener.ts
session_common.coffee       ->      src/session.ts
app.coffee                  ->      src/app.ts
views.coffee                ->      src/views.ts
bodeplot.coffee             ->      src/bodeplot.ts
curvetrace.coffee           ->      src/curvetrace.ts
fwupdate.coffee             ->      src/fwupdate.ts
calibrate.coffee            ->      src/calibrate.ts
debuginfo.coffee            ->      src/debuginfo.ts
editsenseresistor.coffee    ->      src/editsenseresistor.ts
ga-events.coffee            ->      (removed)
calibration_server.coffee   ->      (separate concern, not a browser module)
ui.less                     ->      src/ui.less (compiled at build time)
wizard.css                  ->      src/wizard.css
```

---

## Suggested porting order (dependency graph)

```
Phase 0: toolchain
  |
Phase 1: human-units, export, widgets  (leaf nodes)
  |
Phase 2: dataserver  (depends on nothing in src/)
  |
Phase 3: livegraph  (depends on human-units)
  |
Phase 4: livegraph-data-listener  (depends on dataserver, livegraph)
  |
Phase 5: session  (depends on dataserver)
  |
Phase 6: views, app  (depends on everything above)
  |
Phase 7: bodeplot, curvetrace, fwupdate, calibrate, debuginfo, editsenseresistor
  |
Phase 8: cleanup
```

Each phase produces working, testable output. The old CoffeeScript files remain untouched until Phase 8, so the original app stays functional throughout.
