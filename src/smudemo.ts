/**
 * Minimal test harness for the src/smu WebUSB library.
 * Connects to a CEE or M1K, drives channel A, and plots channel A
 * voltage/current straight from the device ring buffers.
 */

import {
  SMUSession,
  StreamingDevice,
  BootloaderDevice,
  makeSource,
  isSupported,
} from './smu';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const connectBtn = $<HTMLButtonElement>('connect');
const startBtn = $<HTMLButtonElement>('start');
const pauseBtn = $<HTMLButtonElement>('pause');
const applyBtn = $<HTMLButtonElement>('apply');
const outputFieldset = $<HTMLFieldSetElement>('output');
const infoEl = $('info');
const errorEl = $('error');
const readoutEl = $('readout');
const canvas = $<HTMLCanvasElement>('scope');
const ctx = canvas.getContext('2d')!;

const session = new SMUSession();
let device: StreamingDevice | null = null;
let drawScheduled = false;

function setError(msg: string): void {
  errorEl.textContent = msg;
}

function updateButtons(): void {
  const have = !!device;
  startBtn.disabled = !have || device!.captureState;
  pauseBtn.disabled = !have || !device!.captureState;
  outputFieldset.disabled = !have;
}

function showInfo(): void {
  if (!device) {
    infoEl.textContent = 'No device.';
    return;
  }
  const i = device.info;
  infoEl.textContent =
    `${i.model} — serial ${i.serial}, hw ${i.hwVersion}, fw ${i.fwVersion}, ` +
    `${(1 / device.sampleTime / 1000).toFixed(1)} ksps, ` +
    `${device.captureSamples} sample buffer (${device.captureLength.toFixed(2)} s)`;
}

function draw(): void {
  drawScheduled = false;
  if (!device || device.channels.length === 0) return;

  const chan = device.channels[0];
  const [sv, si] = chan.streams;
  const max = device.bufferMax();
  const min = Math.max(device.bufferMin(), max - canvas.width);

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const plot = (stream: typeof sv, color: string): void => {
    const lo = stream.min;
    const hi = stream.max;
    ctx.strokeStyle = color;
    ctx.beginPath();
    let started = false;
    for (let i = min; i < max; i++) {
      const v = device!.get(stream, i);
      if (Number.isNaN(v)) continue;
      const x = i - min;
      const y = canvas.height - ((v - lo) / (hi - lo)) * canvas.height;
      if (started) ctx.lineTo(x, y);
      else { ctx.moveTo(x, y); started = true; }
    }
    ctx.stroke();
  };

  plot(sv, '#4f4');
  if (si) plot(si, '#48f');

  const last = max - 1;
  const v = device.get(sv, last);
  const a = si ? device.get(si, last) : NaN;
  readoutEl.textContent =
    `${chan.displayName}: ${v.toFixed(4)} ${sv.units}` +
    (si ? `   ${a.toFixed(3)} ${si.units}` : '');
}

function attach(dev: StreamingDevice): void {
  device = dev;

  dev.data.subscribe(() => {
    if (!drawScheduled) {
      drawScheduled = true;
      requestAnimationFrame(draw);
    }
  });
  dev.captureStateChanged.subscribe(() => updateButtons());
  dev.configChanged.subscribe(() => showInfo());
  dev.packetDrop.subscribe(() => setError('Dropped packet'));
  dev.error.subscribe((e) => setError(`Stream error: ${e.message}`));
  dev.disconnected.subscribe(() => {
    device = null;
    showInfo();
    updateButtons();
    setError('Device disconnected');
  });

  showInfo();
  updateButtons();
}

connectBtn.onclick = async () => {
  setError('');
  if (!isSupported()) {
    setError('WebUSB is not supported in this browser (use Chrome/Edge/Opera).');
    return;
  }
  try {
    await session.start();
    const usbDev = (await session.requestDevice()) ?? session.available[0];
    if (!usbDev) return;

    const dev = await session.open(usbDev);
    if (dev instanceof BootloaderDevice) {
      infoEl.textContent =
        `Bootloader — ${dev.hwVersion}, serial ${dev.serial}, ` +
        `page ${dev.info.pageSize}, app end 0x${dev.info.appSectionEnd.toString(16)}`;
      return;
    }
    attach(dev);
  } catch (e) {
    setError(e instanceof Error ? e.message : String(e));
  }
};

startBtn.onclick = async () => {
  setError('');
  try {
    await device?.startCapture();
  } catch (e) {
    setError(e instanceof Error ? e.message : String(e));
  }
};

pauseBtn.onclick = async () => {
  try {
    await device?.pauseCapture();
  } catch (e) {
    setError(e instanceof Error ? e.message : String(e));
  }
};

applyBtn.onclick = async () => {
  if (!device) return;
  setError('');
  const mode = parseInt($<HTMLSelectElement>('mode').value, 10);
  const sourceName = $<HTMLSelectElement>('source').value;
  const value = parseFloat($<HTMLInputElement>('value').value);
  const amplitude = parseFloat($<HTMLInputElement>('amplitude').value);
  const freq = parseFloat($<HTMLInputElement>('freq').value);

  try {
    const source =
      sourceName === 'constant'
        ? makeSource({ mode, source: 'constant', value })
        : makeSource({
            mode,
            source: sourceName,
            offset: value,
            amplitude,
            period: 1 / freq / device.sampleTime,
          });
    await device.setOutput(device.channels[0], source);
  } catch (e) {
    setError(e instanceof Error ? e.message : String(e));
  }
};
