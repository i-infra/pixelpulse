/**
 * M1K Advanced Features
 * Monitoring and control of M1K hardware: power, temperature,
 * analog front-end, LEDs, and calibration.
 */

import { server, type CEEDevice } from './dataserver.js';
import { readVBUS } from './m1k-power.js';

// --- Helpers ---

function el<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`Element #${id} not found`);
  return e as T;
}

function show(id: string): void { el(id).style.display = ''; }
function hide(id: string): void { el(id).style.display = 'none'; }
function setText(id: string, text: string): void { el(id).textContent = text; }

// --- State ---

let device: CEEDevice | null = null;
let autoRefreshTimer: ReturnType<typeof setInterval> | null = null;
let autoRefreshOn = false;
let frontendLoaded = false; // don't send changes until first read completes
let ledsLoaded = false;

// --- VBUS readback (shared ADM1177 helper) ---

function refreshVBUS(): void {
  if (!device) return;
  void readVBUS(device).then((r) => {
    if (!r) {
      setText('pwr-vbus-v', 'Error');
      setText('pwr-vbus-i', 'Error');
      return;
    }
    const vEl = el('pwr-vbus-v');
    vEl.textContent = r.voltage.toFixed(3) + ' V';
    vEl.className = '';
    if (r.voltage >= 4.5) {
      vEl.classList.add('status-green');
    } else if (r.voltage >= 4.0) {
      vEl.classList.add('status-yellow');
    } else {
      vEl.classList.add('status-red');
    }

    setText('pwr-vbus-i', r.currentMA.toFixed(1) + ' mA');

    const warning = el('power-warning');
    warning.style.display = r.voltage < 4.0 ? '' : 'none';
  });
}

// --- getPower ---

function refreshPower(): void {
  const id = server.createCallback((data) => {
    const power = (data as Record<string, unknown>).power as Record<string, unknown> | undefined;
    if (!power) return;
    setText('pwr-overcurrent', power.overcurrent ? 'YES' : 'No');
    setText('pwr-status-raw', '0x' + ((power.status_raw as number) ?? 0).toString(16).padStart(2, '0'));
    setText('pwr-alert', power.alert_bit ? 'YES' : 'No');
  });
  server.send('getPower', { id });
  refreshVBUS();
}

// --- getTemperature ---

function refreshTemperature(): void {
  const id = server.createCallback((data) => {
    const temp = (data as Record<string, unknown>).temperature as Record<string, number> | undefined;
    if (!temp) return;
    setText('temp-a', String(temp.a));
    setText('temp-b', String(temp.b));
  });
  server.send('getTemperature', { id });
}

// --- getFrontend / setFrontend ---

const FE_BOOLS = ['r50_2v5', 'r50_gnd', 'feedback', 'output_en', 'split'] as const;
const FE_CHANNELS = ['a', 'b'] as const;

function updateFrontendToggle(ch: string, key: string, val: boolean): void {
  const btn = el<HTMLButtonElement>(`fe-${ch}-${key}`);
  btn.textContent = val ? 'ON' : 'OFF';
  btn.className = 'btn ' + (val ? 'success' : '');
}

function refreshFrontend(): void {
  const id = server.createCallback((data) => {
    const frontend = (data as Record<string, unknown>).frontend as Record<string, Record<string, unknown>> | undefined;
    if (!frontend) return;

    for (const ch of FE_CHANNELS) {
      const chData = frontend[ch];
      if (!chData) continue;

      for (const key of FE_BOOLS) {
        updateFrontendToggle(ch, key, !!chData[key]);
      }

      const pot = chData.pot as number[] | undefined;
      if (pot && pot.length >= 2) {
        const r1Slider = el<HTMLInputElement>(`fe-${ch}-pot_r1`);
        const r2Slider = el<HTMLInputElement>(`fe-${ch}-pot_r2`);
        r1Slider.value = String(pot[0]);
        r2Slider.value = String(pot[1]);
        setText(`fe-${ch}-pot_r1-val`, String(pot[0]));
        setText(`fe-${ch}-pot_r2-val`, String(pot[1]));
      }
    }

    frontendLoaded = true;
  });
  server.send('getFrontend', { id });
}

function sendFrontendToggle(ch: string, key: string, currentVal: boolean): void {
  if (!frontendLoaded) return;
  const newVal = !currentVal;
  const params: Record<string, unknown> = { channel: ch };
  params[key] = newVal;
  const id = server.createCallback(() => {
    updateFrontendToggle(ch, key, newVal);
  });
  params.id = id;
  server.send('setFrontend', params);
}

function sendFrontendPot(ch: string, potKey: string, value: number): void {
  if (!frontendLoaded) return;
  const params: Record<string, unknown> = { channel: ch };
  params[potKey] = value;
  const id = server.createCallback(() => { /* ack */ });
  params.id = id;
  server.send('setFrontend', params);
}

// --- getLED / setLED ---

let ledState = { red: false, green: false, blue: false };

function refreshLEDs(): void {
  const id = server.createCallback((data) => {
    const leds = (data as Record<string, unknown>).leds as Record<string, unknown> | undefined;
    if (!leds) return;
    ledState.red = !!leds.red;
    ledState.green = !!leds.green;
    ledState.blue = !!leds.blue;
    const raw = (leds.leds as number) ?? 0;
    updateLEDUI(raw);
    ledsLoaded = true;
  });
  server.send('getLED', { id });
}

function updateLEDUI(raw: number): void {
  const redBtn = el<HTMLButtonElement>('led-red');
  const greenBtn = el<HTMLButtonElement>('led-green');
  const blueBtn = el<HTMLButtonElement>('led-blue');

  redBtn.className = 'btn led-btn' + (ledState.red ? ' active-red' : '');
  greenBtn.className = 'btn led-btn' + (ledState.green ? ' active-green' : '');
  blueBtn.className = 'btn led-btn' + (ledState.blue ? ' active-blue' : '');

  setText('led-raw', '0b' + raw.toString(2).padStart(3, '0') + ' (0x' + raw.toString(16) + ')');
}

function toggleLED(color: 'red' | 'green' | 'blue'): void {
  if (!ledsLoaded) return;
  ledState[color] = !ledState[color];
  const params: Record<string, unknown> = {
    red: ledState.red,
    green: ledState.green,
    blue: ledState.blue,
  };
  const id = server.createCallback((data) => {
    // Re-read raw value if returned, otherwise compute
    const leds = (data as Record<string, unknown>).leds as number | undefined;
    const raw = leds ?? ((ledState.red ? 1 : 0) | (ledState.green ? 2 : 0) | (ledState.blue ? 4 : 0));
    updateLEDUI(raw);
  });
  params.id = id;
  server.send('setLED', params);
}

// --- readCalibration ---

function refreshCalibration(): void {
  const id = server.createCallback((data) => {
    const d = data as Record<string, unknown>;
    const valid = d.valid as boolean | undefined;
    setText('cal-valid', valid ? 'Yes' : 'No / Not present');

    const offset = d.offset as number[] | undefined;
    const gain_p = d.gain_p as number[] | undefined;
    const gain_n = d.gain_n as number[] | undefined;

    for (let i = 0; i < 8; i++) {
      setText(`cal-off-${i}`, offset ? offset[i].toExponential(4) : '--');
      setText(`cal-gp-${i}`, gain_p ? gain_p[i].toFixed(6) : '--');
      setText(`cal-gn-${i}`, gain_n ? gain_n[i].toFixed(6) : '--');
    }
  });
  server.send('readCalibration', { id });
}

// --- Refresh all ---
// Only safe (cached) reads on refreshAll — power and temperature send USB
// control transfers to firmware that disrupt streaming (0x17 does I2C,
// 0x19 reconfigures the ADCs mid-stream).

function refreshSafe(): void {
  if (!device) return;
  refreshPower();
  refreshFrontend();
  refreshLEDs();
  refreshCalibration();
}

function refreshHardware(): void {
  if (!device) return;
  refreshTemperature();
}

// --- Auto-refresh ---

function toggleAutoRefresh(): void {
  autoRefreshOn = !autoRefreshOn;
  const btn = el<HTMLButtonElement>('btn-auto-refresh');
  if (autoRefreshOn) {
    btn.textContent = 'Auto-Refresh: ON';
    btn.className = 'btn success';
    autoRefreshTimer = setInterval(refreshSafe, 2000);
  } else {
    btn.textContent = 'Auto-Refresh: OFF';
    btn.className = 'btn info';
    if (autoRefreshTimer !== null) {
      clearInterval(autoRefreshTimer);
      autoRefreshTimer = null;
    }
  }
}

// --- Device selection ---

function chooseDevice(): void {
  const m1k = server.devices.find(d => d.model === 'com.analogdevices.m1k');
  if (m1k) {
    device = server.selectDevice(m1k) as CEEDevice;
    device.changed.subscribe(onDeviceReady);
  } else {
    device = null;
    hide('device-info');
    show('no-device');
  }
}

function onDeviceReady(dev: CEEDevice): void {
  hide('no-device');
  hide('no-connect');
  show('device-info');

  setText('dev-model', dev.model);
  setText('dev-hw', dev.hwVersion);
  setText('dev-fw', dev.fwVersion);
  setText('dev-serial', dev.serial);

  frontendLoaded = false;
  ledsLoaded = false;
  refreshSafe();
}

// --- Wire up event handlers ---

function bindEvents(): void {
  el('btn-refresh-all').addEventListener('click', refreshSafe);
  el('btn-auto-refresh').addEventListener('click', toggleAutoRefresh);
  el('btn-refresh-power').addEventListener('click', () => { refreshHardware(); });

  // Frontend toggles
  for (const ch of FE_CHANNELS) {
    for (const key of FE_BOOLS) {
      const btnId = `fe-${ch}-${key}`;
      el(btnId).addEventListener('click', () => {
        const currentText = el(btnId).textContent;
        sendFrontendToggle(ch, key, currentText === 'ON');
      });
    }

    // Pot sliders
    for (const pot of ['pot_r1', 'pot_r2'] as const) {
      const sliderId = `fe-${ch}-${pot}`;
      const slider = el<HTMLInputElement>(sliderId);
      slider.addEventListener('input', () => {
        setText(`${sliderId}-val`, slider.value);
      });
      slider.addEventListener('change', () => {
        sendFrontendPot(ch, pot, parseInt(slider.value, 10));
      });
    }
  }

  // LED toggles
  el('led-red').addEventListener('click', () => toggleLED('red'));
  el('led-green').addEventListener('click', () => toggleLED('green'));
  el('led-blue').addEventListener('click', () => toggleLED('blue'));
}

// --- Init ---

document.addEventListener('DOMContentLoaded', () => {
  bindEvents();

  server.connect();

  server.disconnected.subscribe(() => {
    hide('device-info');
    hide('no-device');
    show('no-connect');
    device = null;
    if (autoRefreshTimer !== null) {
      clearInterval(autoRefreshTimer);
      autoRefreshTimer = null;
      autoRefreshOn = false;
      el<HTMLButtonElement>('btn-auto-refresh').textContent = 'Auto-Refresh: OFF';
      el<HTMLButtonElement>('btn-auto-refresh').className = 'btn info';
    }
  });

  server.connected.subscribe(() => {
    hide('no-connect');
  });

  server.devicesChanged.subscribe(chooseDevice);
});
