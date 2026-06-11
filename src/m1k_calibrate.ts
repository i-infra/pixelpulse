/**
 * M1K (ADALM1000) guided calibration wizard.
 *
 * Implements the procedure from
 * https://wiki.analog.com/university/tools/m1k-calibration with most steps
 * automated:
 *  - Measure-V: fully automatic. The ADG619 input switches (r50_gnd /
 *    r50_2v5) connect each input to GND or the 2.5 V rail through the 50R
 *    resistor; in HI_Z no current flows, so the switch Ron and resistor
 *    drop zero volts and the input sees the rail exactly. The only manual
 *    measurement in the whole procedure is the true rail voltage (DMM).
 *  - Source-V: automatic self-readback using the just-computed measure-V
 *    calibration (output is unloaded, so readback equals output).
 *  - Measure-I / Source-I: one external precision resistor from the channel
 *    pin to the 2.5 V pin. True current is derived from the calibrated
 *    voltage readback: I = (Vpin - Vrail) / R. No ammeter needed.
 *
 * Gain/offset math mirrors libsmu's write_calibration() exactly
 * (offset = measured@0 - ref@0; gain± = mean(ref / (measured - offset))),
 * so the EEPROM contents match what `smu -w <calfile>` would produce.
 * Current calibration sets are in amps, matching the cal file format.
 */

import { server, Listener, type CEEDevice, type Channel, type Stream } from './dataserver.js';

// Calibration set indexes (match m1k.hpp / libsmu):
// 0: A measure V   1: A measure I   2: A source V   3: A source I
// 4: B measure V   5: B measure I   6: B source V   7: B source I

interface CalPair { ref: number; val: number }
interface CalSet { offset: number; gain_p: number; gain_n: number }

const SET_NAMES = [
  'A measure V', 'A measure I', 'A source V', 'A source I',
  'B measure V', 'B measure I', 'B source V', 'B source I',
];

const HI_Z = 0, SVMI = 1, SIMV = 2;
const CAPTURE_SECONDS = 0.4;
const SETTLE_MS = 300;

let device: CEEDevice | null = null;
const pairs: CalPair[][] = Array.from({ length: 8 }, () => []);
let newCal: CalSet[] | null = null;
let oldCal: { offset: number[]; gain_p: number[]; gain_n: number[]; valid: boolean } | null = null;
let railV = 2.5;
let rExt = 25.0;

// --- DOM helpers ---

function el<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`Element #${id} not found`);
  return e as T;
}

function show(id: string): void { el(id).style.display = ''; }
function hide(id: string): void { el(id).style.display = 'none'; }
function setText(id: string, text: string): void { el(id).textContent = text; }

function log(msg: string, cls?: string): void {
  const div = document.createElement('div');
  div.textContent = msg;
  if (cls) div.className = cls;
  el('log').appendChild(div);
  div.scrollIntoView({ block: 'nearest' });
}

function fail(msg: string): never {
  log(`✗ ${msg}`, 'log-err');
  throw new Error(msg);
}

// --- Device helpers ---

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function sendWithCallback(cmd: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    params.id = server.createCallback(resolve);
    server.send(cmd, params);
  });
}

function setFrontend(ch: 'a' | 'b', settings: Record<string, boolean>): Promise<Record<string, unknown>> {
  return sendWithCallback('setFrontend', { channel: ch, ...settings });
}

// Capture one server-side boxcar average of `seconds` worth of samples
function captureSample(stream: Stream, seconds = CAPTURE_SECONDS): Promise<number> {
  return new Promise((resolve, reject) => {
    if (!device) return reject(new Error('no device'));
    const l = new Listener(device, [stream]);
    const timer = setTimeout(() => { l.cancel(); reject(new Error('capture timed out')); }, 5000 + seconds * 1000);
    l.updated.subscribe((m) => {
      clearTimeout(timer);
      const v = m.data[0][m.data[0].length - 1];
      l.cancel();
      resolve(v);
    });
    l.configure(false, seconds, 1);
    l.submit();
  });
}

function chan(ch: 'a' | 'b'): Channel {
  if (!device) throw new Error('no device');
  return device.channels[ch];
}

function vStream(ch: 'a' | 'b'): Stream { return chan(ch).streams.v; }
function iStream(ch: 'a' | 'b'): Stream { return chan(ch).streams.i; }

async function setMode(ch: 'a' | 'b', mode: number, value = 0): Promise<void> {
  chan(ch).setConstant(mode, value);
  await sleep(SETTLE_MS);
}

// --- Calibration math (mirrors libsmu write_calibration) ---

function computeSet(p: CalPair[]): CalSet {
  if (p.length < 1) return { offset: 0, gain_p: 1, gain_n: 1 };
  const offset = p[0].val - p[0].ref;
  let gp = 0, cp = 0, gn = 0, cn = 0;
  for (let i = 1; i < p.length; i++) {
    if (p[i].ref > 0) {
      gp += p[i].ref / (p[i].val - offset);
      cp++;
    } else {
      gn += p[i].ref / (p[i].val - offset);
      cn++;
    }
  }
  return { offset, gain_p: cp ? gp / cp : 1.0, gain_n: cn ? gn / cn : 1.0 };
}

// Apply a measure-V calibration set to a raw reading (same sign convention
// as the server: gain chosen by sign of the raw value)
function applyCal(raw: number, c: CalSet): number {
  return (raw - c.offset) * (raw > 0 ? c.gain_p : c.gain_n);
}

// --- Wizard steps ---

function readInputs(): void {
  railV = parseFloat(el<HTMLInputElement>('inp-rail').value);
  rExt = parseFloat(el<HTMLInputElement>('inp-rext').value);
  if (!(railV > 2 && railV < 3)) fail(`Rail voltage ${railV} out of plausible range (2..3 V)`);
  if (!(rExt >= 2.5 && rExt <= 100)) fail(`Resistor ${rExt} out of supported range (2.5..100 Ω)`);
}

async function stepReset(): Promise<void> {
  readInputs();
  log('Resetting device calibration to defaults (identity)…');
  const identity = {
    offset: Array(8).fill(0),
    gain_p: Array(8).fill(1),
    gain_n: Array(8).fill(1),
  };
  const r = await sendWithCallback('writeCalibration', identity);
  if ((r.status as number) <= 0) fail(`writeCalibration failed (status ${r.status})`);
  log('✓ Calibration reset; captures below are raw device readings', 'log-ok');

  for (const ch of ['a', 'b'] as const) {
    await setFrontend(ch, { r50_2v5: false, r50_gnd: false });
    await setMode(ch, HI_Z);
  }
  for (let i = 0; i < 8; i++) pairs[i] = [];
  newCal = null;
}

// Measure-V: both channels in HI_Z; switch inputs to GND, then to the rail.
async function stepMeasureV(): Promise<void> {
  for (const [ch, set] of [['a', 0], ['b', 4]] as const) {
    await setMode(ch, HI_Z);

    await setFrontend(ch, { r50_2v5: false, r50_gnd: true });
    await sleep(SETTLE_MS);
    const v0 = await captureSample(vStream(ch));
    pairs[set].push({ ref: 0, val: v0 });
    log(`CH ${ch.toUpperCase()} input @ GND: reads ${v0.toFixed(5)} V`);

    await setFrontend(ch, { r50_gnd: false, r50_2v5: true });
    await sleep(SETTLE_MS);
    const v25 = await captureSample(vStream(ch));
    pairs[set].push({ ref: railV, val: v25 });
    log(`CH ${ch.toUpperCase()} input @ rail (${railV.toFixed(4)} V): reads ${v25.toFixed(5)} V`);

    await setFrontend(ch, { r50_2v5: false, r50_gnd: false });
  }
  log('✓ Measure-V captured for both channels', 'log-ok');
}

// Source-V: unloaded output read back through the now-known measure-V cal.
async function stepSourceV(): Promise<void> {
  for (const [ch, mvSet, svSet] of [['a', 0, 2], ['b', 4, 6]] as const) {
    if (pairs[mvSet].length < 2) fail(`Measure-V for channel ${ch.toUpperCase()} not captured yet`);
    const mv = computeSet(pairs[mvSet]);

    for (const target of [0, 2.5]) {
      await setMode(ch, SVMI, target);
      const raw = await captureSample(vStream(ch));
      const actual = applyCal(raw, mv);
      pairs[svSet].push({ ref: target, val: actual });
      log(`CH ${ch.toUpperCase()} sourcing ${target.toFixed(4)} V: output measures ${actual.toFixed(5)} V`);
    }
    await setMode(ch, HI_Z);
  }
  log('✓ Source-V captured (self-readback, unloaded)', 'log-ok');
}

// Measure-I zero: channel pins must be physically unconnected.
async function stepMeasureIZero(): Promise<void> {
  for (const [ch, set] of [['a', 1], ['b', 5]] as const) {
    await setFrontend(ch, { r50_2v5: false, r50_gnd: false });
    await setMode(ch, SVMI, 2.5);
    const iRaw = await captureSample(iStream(ch)) / 1000; // mA -> A
    pairs[set].push({ ref: 0, val: iRaw });
    log(`CH ${ch.toUpperCase()} open-circuit current: ${(iRaw * 1000).toFixed(4)} mA`);
    await setMode(ch, HI_Z);
  }
  log('✓ Measure-I zero captured', 'log-ok');
}

// Current calibration for one channel: precision resistor from CH pin to
// the 2.5 V pin. True current derived from calibrated voltage readback.
async function stepCurrent(ch: 'a' | 'b'): Promise<void> {
  const mvSet = ch === 'a' ? 0 : 4;
  const miSet = ch === 'a' ? 1 : 5;
  const siSet = ch === 'a' ? 3 : 7;
  if (pairs[mvSet].length < 2) fail(`Measure-V for channel ${ch.toUpperCase()} not captured yet`);
  if (pairs[miSet].length < 1) fail(`Measure-I zero for channel ${ch.toUpperCase()} not captured yet`);
  const mv = computeSet(pairs[mvSet]);

  // Measure-I gain: source voltage above/below the rail; the true current
  // through the resistor follows from the calibrated pin voltage.
  for (const vTarget of [4.7, 0.3]) {
    await setMode(ch, SVMI, vTarget);
    const vPin = applyCal(await captureSample(vStream(ch)), mv);
    const iRaw = await captureSample(iStream(ch)) / 1000; // mA -> A
    const iTrue = (vPin - railV) / rExt;
    if (Math.abs(iTrue) < 0.005) {
      fail(`Only ${(iTrue * 1000).toFixed(2)} mA is flowing on CH ${ch.toUpperCase()} — is the resistor connected from the channel pin to the 2.5 V pin?`);
    }
    pairs[miSet].push({ ref: iTrue, val: iRaw });
    log(`CH ${ch.toUpperCase()} @ ${vPin.toFixed(4)} V: true ${(iTrue * 1000).toFixed(3)} mA, reads ${(iRaw * 1000).toFixed(3)} mA`);
  }

  // Source-I: command currents, derive the true value the same way.
  // 0 A first (offset point), then symmetric points within the safe range.
  const iCmdMa = Math.min(100, Math.floor(2000 / rExt));
  for (const cmdMa of [0, iCmdMa, -iCmdMa]) {
    await setMode(ch, SIMV, cmdMa);
    const vPin = applyCal(await captureSample(vStream(ch)), mv);
    const iTrue = (vPin - railV) / rExt;
    pairs[siSet].push({ ref: cmdMa / 1000, val: iTrue });
    log(`CH ${ch.toUpperCase()} sourcing ${cmdMa} mA: true ${(iTrue * 1000).toFixed(3)} mA`);
  }

  await setMode(ch, HI_Z);
  log(`✓ Current calibration captured for CH ${ch.toUpperCase()}`, 'log-ok');
}

// --- Review / write / verify ---

function renderReview(): void {
  newCal = pairs.map(computeSet);
  const tbody = el('review-body');
  tbody.innerHTML = '';
  for (let i = 0; i < 8; i++) {
    const c = newCal[i];
    const row = document.createElement('tr');
    const cells = [
      SET_NAMES[i],
      c.offset.toExponential(4),
      c.gain_p.toFixed(6),
      c.gain_n.toFixed(6),
      oldCal ? oldCal.offset[i].toExponential(4) : '--',
      oldCal ? oldCal.gain_p[i].toFixed(6) : '--',
    ];
    for (const text of cells) {
      const td = document.createElement('td');
      td.textContent = text;
      row.appendChild(td);
    }
    // sanity highlight: gains should be near 1
    if (Math.abs(c.gain_p - 1) > 0.2 || Math.abs(c.gain_n - 1) > 0.2 || Math.abs(c.offset) > 0.3) {
      row.className = 'suspect';
    }
    tbody.appendChild(row);
  }
  show('step-review');
}

async function writeCal(): Promise<void> {
  if (!newCal) fail('Nothing to write');
  const r = await sendWithCallback('writeCalibration', {
    offset: newCal.map(c => c.offset),
    gain_p: newCal.map(c => c.gain_p),
    gain_n: newCal.map(c => c.gain_n),
  });
  if ((r.status as number) <= 0) fail(`writeCalibration failed (status ${r.status})`);
  log('✓ Calibration written to EEPROM and applied', 'log-ok');

  // Verify: with the new cal active, the input switched to the rail should
  // read the DMM rail value, and sourcing 2.5 V should read back 2.5 V.
  for (const ch of ['a', 'b'] as const) {
    await setMode(ch, HI_Z);
    await setFrontend(ch, { r50_2v5: true, r50_gnd: false });
    await sleep(SETTLE_MS);
    const v = await captureSample(vStream(ch));
    await setFrontend(ch, { r50_2v5: false, r50_gnd: false });
    const err = v - railV;
    log(`Verify CH ${ch.toUpperCase()}: rail reads ${v.toFixed(5)} V (error ${(err * 1000).toFixed(2)} mV)`,
      Math.abs(err) < 0.005 ? 'log-ok' : 'log-err');
  }
  log('Done. Reload any open pixelpulse tabs to see calibrated readings.', 'log-ok');
}

// --- Step runner / UI wiring ---

let busy = false;

function runStep(id: string, fn: () => Promise<void>, nextId?: string): void {
  el(`btn-${id}`).addEventListener('click', async () => {
    if (busy || !device) return;
    busy = true;
    el<HTMLButtonElement>(`btn-${id}`).disabled = true;
    try {
      await fn();
      if (nextId) show(`step-${nextId}`);
    } catch (e) {
      console.error(e);
      el<HTMLButtonElement>(`btn-${id}`).disabled = false;
    } finally {
      busy = false;
    }
  });
}

function chooseDevice(): void {
  const m1k = server.devices.find(d => d.model === 'com.analogdevices.m1k');
  if (m1k) {
    device = server.selectDevice(m1k) as CEEDevice;
    device.changed.subscribe(onDeviceReady);
  } else {
    device = null;
    hide('wizard');
    show('no-device');
  }
}

function onDeviceReady(dev: CEEDevice): void {
  hide('no-device');
  hide('no-connect');
  show('wizard');
  setText('dev-info', `${dev.model} — hw ${dev.hwVersion}, fw ${dev.fwVersion}, serial ${dev.serial}`);

  // Need a running capture for listeners; mirror pixelpulse defaults
  if (!dev.captureState) {
    dev.configure({});
    dev.startCapture();
  }

  sendWithCallback('readCalibration').then((d) => {
    oldCal = {
      offset: d.offset as number[],
      gain_p: d.gain_p as number[],
      gain_n: d.gain_n as number[],
      valid: !!d.valid,
    };
    setText('cal-status', oldCal.valid
      ? 'Device has valid calibration data (will be replaced).'
      : 'Device calibration is INVALID — running on defaults. Calibration recommended.');
  });
}

document.addEventListener('DOMContentLoaded', () => {
  runStep('reset', stepReset, 'measure-v');
  runStep('measure-v', stepMeasureV, 'source-v');
  runStep('source-v', stepSourceV, 'measure-i-zero');
  runStep('measure-i-zero', stepMeasureIZero, 'current-a');
  runStep('current-a', () => stepCurrent('a'), 'current-b');
  runStep('current-b', async () => { await stepCurrent('b'); renderReview(); });
  runStep('write', writeCal);

  server.connect();
  server.connected.subscribe(() => hide('no-connect'));
  server.disconnected.subscribe(() => {
    show('no-connect');
    hide('wizard');
    device = null;
  });
  server.devicesChanged.subscribe(chooseDevice);
});
