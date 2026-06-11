/**
 * Device access layer for the Pixelpulse UI, backed by WebUSB.
 *
 * Historically this module was a WebSocket client for the Nonolith Connect
 * daemon (dataserver.coffee). It now drives the hardware directly through
 * the src/smu/ WebUSB library while preserving the same public API —
 * Dataserver/Device/CEEDevice/Channel/Stream/Listener/DataListener and the
 * `server.send(cmd, params)` command surface — so the application pages
 * are unchanged.
 *
 * Original protocol: (C) 2011 Nonolith Labs, Kevin Mehall <km@kevinmehall.net>
 * Distributed under the terms of the GNU LGPLv3
 */

import {
  TypedEvent,
  SMUSession,
  isSupported,
  StreamingDevice as SmuStreamingDevice,
  CEEDevice as SmuCEEDevice,
  M1KDevice as SmuM1KDevice,
  BootloaderDevice as SmuBootloaderDevice,
  StreamListener,
  makeSource,
} from './smu/index.js';
import type {
  SMUDevice,
  Channel as SmuChannel,
  SourceDescription,
  TriggerConfig as SmuTriggerConfig,
  M1KFrontendSwitch,
} from './smu/index.js';

export { TypedEvent };

export function webusbSupported(): boolean {
  return isSupported();
}

// --- Info shapes (kept from the WS protocol; pages consume these) ---

export interface DeviceInfo {
  id: string;
  model: string;
  serial: string;
  hwVersion: string;
  fwVersion: string;
}

export interface CEEDeviceInfo extends DeviceInfo {
  length: number;
  continuous: boolean;
  sampleTime: number;
  captureState: boolean;
  captureDone: boolean;
  mode: number;
  samples: number;
  raw: boolean;
  minSampleTime: number;
  channels: Record<string, ChannelInfo>;
}

export interface ChannelInfo {
  id: string;
  displayName: string;
  output: OutputSource;
  streams: Record<string, StreamInfo>;
}

export interface StreamInfo {
  id: string;
  displayName: string;
  units: string;
  min: number;
  max: number;
  outputMode: string | number;
  gain: number;
  uncertainty: number;
}

export interface OutputSource {
  mode: string | number;
  source: string;
  value?: number;
  offset?: number;
  amplitude?: number;
  period?: number;
  high?: number;
  low?: number;
  highSamples?: number;
  lowSamples?: number;
  hint?: string;
  dutyCycleHint?: number;
  [key: string]: unknown;
}

export interface TriggerConfig {
  type: string;
  channel: string;
  stream: string;
  level: number;
  holdoff: number;
  offset: number;
  force: number;
}

// --- Helpers ---

function removeNull(val: string | undefined | null): string {
  return val ? val.replace(/\0/g, '') : '';
}

function toHex(val: number): string {
  return (val >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

/** Byte-swap a u32 (struct fields were displayed via ntohl in Connect) */
function bswap32(v: number): number {
  return (((v & 0xff) << 24) | ((v & 0xff00) << 8) | ((v >>> 8) & 0xff00) | (v >>> 24)) >>> 0;
}

type Reply = Record<string, unknown>;
type Callback = (data: Reply) => void;

// --- Dataserver ---

export class Dataserver {
  connected = new TypedEvent();
  disconnected = new TypedEvent();
  devicesChanged = new TypedEvent<[Device[]]>();

  devices: Device[] = [];
  device: CEEDevice | BootloaderDevice | null = null;

  // Connect-protocol version; kept >= the GUI's feature gates (adv_square,
  // out-trigger need >= 1.2)
  version = '1.3';
  gitVersion = 'webusb';

  readonly session = new SMUSession();

  private callbacks: Record<number | string, Callback> = {};
  private records = new Map<USBDevice, Device>();
  private refreshing: Promise<void> | null = null;

  /** `host` is unused (kept for API compatibility with the WS client) */
  constructor(public host: string) {}

  connect(): void {
    if (!isSupported()) {
      console.error('WebUSB is not supported in this browser');
      this.disconnected.notify();
      return;
    }

    this.session.devicesChanged.subscribe(() => {
      void this.refreshDevices();
    });

    void this.session
      .start()
      .then(() => this.connected.notify())
      .catch((e) => {
        console.error('WebUSB session failed:', e);
        this.disconnected.notify();
      });
  }

  /**
   * Show the browser's USB device chooser to pair a new device.
   * Must be called from a user gesture (click handler).
   */
  async requestDevice(): Promise<void> {
    await this.session.requestDevice();
  }

  private refreshDevices(): Promise<void> {
    // Serialize refreshes so a hotplug during driver init can't interleave
    const prev = this.refreshing ?? Promise.resolve();
    const next = prev.then(() => this.doRefreshDevices());
    this.refreshing = next.finally(() => {
      if (this.refreshing === next) this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefreshDevices(): Promise<void> {
    const available = this.session.available;

    // Drop records for detached devices
    for (const usb of [...this.records.keys()]) {
      if (!available.includes(usb)) {
        this.records.delete(usb);
      }
    }

    // Open drivers for newly attached devices (Connect also opened every
    // device at attach; this is what populates serial/hw/fw in the list)
    for (const usb of available) {
      if (this.records.has(usb)) continue;
      try {
        const driver = await this.session.open(usb);
        this.records.set(usb, new Device(driver));
      } catch (e) {
        console.error('Could not open device (in use by another tab?):', e);
      }
    }

    this.devices = [...this.records.values()];

    // If the active device went away, mirror the WS 'deviceDisconnected' flow
    if (this.device && !this.devices.some((d) => d.driver === this.device!.driver)) {
      const d = this.device;
      this.device = null;
      d.dispose();
      d.removed.notify();
    }

    this.updatePairButton();
    this.devicesChanged.notify(this.devices);
  }

  send(cmd: string, m: Record<string, unknown> = {}): void {
    void this.dispatch(cmd, m);
  }

  private async dispatch(cmd: string, m: Record<string, unknown>): Promise<void> {
    const id = m.id as number | string | undefined;
    try {
      const reply = (await this.device?.handleCommand(cmd, m)) ?? {};
      if (id != null && id !== '') {
        reply._action = 'return';
        reply.id = id;
        this.runCallback(id, reply);
      }
    } catch (e) {
      console.error(`Command ${cmd} failed:`, e);
      if (id != null && id !== '') {
        this.runCallback(id, { _action: 'return', id, error: String(e), status: -1 });
      }
    }
  }

  selectDevice(device: Device): CEEDevice | BootloaderDevice {
    if (this.device) {
      this.device.dispose();
      (this.device as CEEDevice).onRemoved?.();
    }
    this.device = device.makeActiveObj(this);
    return this.device;
  }

  createCallback(fn?: Callback): number | string {
    if (fn) {
      const id = (+new Date() + Math.round(Math.random() * 100000)) & 0xfffffff;
      this.callbacks[id] = fn;
      return id;
    }
    return '';
  }

  private runCallback(id: number | string, data: Reply, remove = true): void {
    if (this.callbacks[id]) {
      this.callbacks[id](data);
      if (remove) delete this.callbacks[id];
    }
  }

  // --- Pairing UI ---
  // WebUSB needs a user gesture to grant access to a new device. When no
  // granted devices are present, float a pairing button over whatever page
  // is showing so every app gets the flow without page-specific UI.

  private pairButton: HTMLButtonElement | null = null;

  private updatePairButton(): void {
    if (typeof document === 'undefined') return;

    if (this.devices.length > 0) {
      this.pairButton?.remove();
      this.pairButton = null;
      return;
    }

    if (this.pairButton) return;

    const btn = document.createElement('button');
    btn.textContent = '\u{1F50C} Connect USB device…';
    btn.style.cssText =
      'position:fixed;top:12px;right:12px;z-index:10000;font-size:15px;' +
      'padding:8px 14px;cursor:pointer;border-radius:6px;border:1px solid #888;';
    btn.addEventListener('click', () => {
      void this.requestDevice();
    });
    this.pairButton = btn;

    const attach = (): void => {
      document.body.appendChild(btn);
    };
    if (document.body) attach();
    else document.addEventListener('DOMContentLoaded', attach);
  }
}

// --- Device (list entry; the driver is already open) ---

export class Device {
  id: string;
  model: string;
  serial: string;
  hwVersion: string;
  fwVersion: string;

  constructor(public readonly driver: SMUDevice) {
    this.model = driver.model;
    this.serial = removeNull(driver.serial);
    this.id = this.model + '~' + this.serial;
    this.hwVersion = removeNull(driver.hwVersion);
    this.fwVersion = removeNull(driver.fwVersion);
  }

  makeActiveObj(parent: Dataserver): CEEDevice | BootloaderDevice {
    if (this.driver instanceof SmuBootloaderDevice) {
      return new BootloaderDevice(parent, this.driver);
    }
    return new CEEDevice(parent, this.driver as SmuStreamingDevice);
  }
}

// --- CEE Device (active, selected device; also used for the M1K) ---

export class CEEDevice {
  changed = new TypedEvent<[CEEDevice]>();
  removed = new TypedEvent();
  captureStateChanged = new TypedEvent<[boolean]>();
  samplesReset = new TypedEvent();

  listenersById: Record<number, Listener> = {};
  channels: Record<string, Channel> = {};

  id = '';
  model = '';
  serial = '';
  hwVersion = '';
  fwVersion = '';
  length = 0;
  continuous = false;
  sampleTime = 0;
  captureState = false;
  captureDone = false;
  mode = 0;
  samples = 0;
  raw = false;
  minSampleTime = 1 / 40e3;
  hasOutTrigger = false;
  hasAdvSquare = false;
  hasGain = true;

  private smuListeners = new Map<number, StreamListener>();
  private disposers: Array<() => void> = [];
  private disposed = false;

  constructor(public parent: Dataserver, public readonly driver: SmuStreamingDevice) {
    const on = <T extends unknown[]>(ev: TypedEvent<T>, fn: (...args: T) => void): void => {
      ev.subscribe(fn);
      this.disposers.push(() => ev.unListen(fn));
    };

    on<[SmuStreamingDevice]>(this.driver.configChanged, () => this.onConfig());
    on(this.driver.captureStateChanged, (state, done) => {
      this.captureState = state;
      this.captureDone = done;
      this.captureStateChanged.notify(this.captureState);
    });
    on(this.driver.captureReset, () => {
      for (const sl of this.smuListeners.values()) sl.reset();
      this.samplesReset.notify();
      for (const id in this.listenersById) {
        this.listenersById[id].onReset();
      }
    });
    on<[SmuStreamingDevice]>(this.driver.data, () => this.pumpListeners());
    on(this.driver.outputChanged, (ch, src) => {
      this.channels[ch.id]?.onOutputChanged(src.describe() as OutputSource);
    });
    on(this.driver.gainChanged, (ch, st, gain) => {
      this.channels[ch.id]?.streams[st.id]?.onGain(gain);
    });
    on(this.driver.packetDrop, () => console.log('dropped packet'));
    on(this.driver.disconnected, () => {
      // Hotplug removal of the active device is handled centrally by
      // Dataserver.refreshDevices; just stop our listeners here.
      this.smuListeners.clear();
    });

    // Deliver the initial configuration after the caller has had a chance
    // to subscribe `changed` (mirrors the async WS deviceConfig message)
    queueMicrotask(() => {
      if (!this.disposed) this.onConfig();
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const d of this.disposers) d();
    this.disposers = [];
    this.smuListeners.clear();
  }

  private onConfig(): void {
    const d = this.driver;

    const channels: Record<string, ChannelInfo> = {};
    for (const ch of d.channels) {
      const streams: Record<string, StreamInfo> = {};
      for (const s of ch.streams) {
        streams[s.id] = {
          id: s.id,
          displayName: s.displayName,
          units: s.units,
          min: s.min,
          max: s.max,
          outputMode: s.outputMode,
          gain: s.getGain(),
          uncertainty: s.uncertainty,
        };
      }
      channels[ch.id] = {
        id: ch.id,
        displayName: ch.displayName,
        output: (ch.source?.describe() ?? { mode: 0, source: 'constant', value: 0 }) as OutputSource,
        streams,
      };
    }

    this.onInfo({
      id: this.parent.devices.find((rec) => rec.driver === d)?.id ?? d.serial,
      model: d.model,
      serial: d.serial,
      hwVersion: d.hwVersion,
      fwVersion: d.fwVersion,
      length: d.captureLength,
      continuous: d.captureContinuous,
      sampleTime: d.sampleTime,
      captureState: d.captureState,
      captureDone: d.captureDone,
      mode: d.devMode,
      samples: d.captureSamples,
      raw: d.rawMode,
      minSampleTime: d.minSampleTime,
      channels,
    });
  }

  onInfo(info: CEEDeviceInfo): void {
    this.id = info.id;
    this.model = info.model;
    this.serial = removeNull(info.serial);
    this.length = info.length;
    this.continuous = info.continuous;
    this.sampleTime = info.sampleTime;
    this.captureState = info.captureState;
    this.captureDone = info.captureDone;
    this.mode = info.mode;
    this.samples = info.samples;
    this.raw = info.raw;
    this.hwVersion = removeNull(info.hwVersion);
    this.fwVersion = removeNull(info.fwVersion);
    this.minSampleTime = info.minSampleTime ?? 1 / 40e3;

    this.channels = {};
    for (const [chanId, chanInfo] of Object.entries(info.channels)) {
      this.channels[chanId] = new Channel(chanInfo, this);
    }

    // Reconfiguration invalidates listeners (Connect cleared them too)
    this.listenersById = {};
    this.smuListeners.clear();

    this.hasOutTrigger = this.parent.version >= '1.2' && this.fwVersion >= '1.2';
    this.hasAdvSquare = this.parent.version >= '1.2';
    // M1K has a fixed analog frontend with no programmable gain
    this.hasGain = this.model !== 'com.analogdevices.m1k';

    this.changed.notify(this);
  }

  onRemoved(): void {
    for (const channel of Object.values(this.channels)) {
      channel.onRemoved();
    }
    this.removed.notify();
  }

  configure(setopts: Record<string, unknown> = {}): void {
    const opts: Record<string, unknown> = {
      mode: 0,
      sampleTime: this.sampleTime,
      continuous: this.continuous,
      raw: this.raw,
    };
    for (const [k, v] of Object.entries(setopts)) {
      opts[k] = v;
    }
    if (opts.samples == null) {
      opts.samples = this.length / (opts.sampleTime as number);
    }
    this.parent.send('configure', opts);
  }

  startCapture(): void {
    this.parent.send('startCapture');
  }

  pauseCapture(): void {
    this.parent.send('pauseCapture');
  }

  controlTransfer(
    bmRequestType: number, bRequest: number, wValue: number, wIndex: number,
    data: number[] = [], wLength = 64,
    callback?: Callback,
  ): void {
    const id = this.parent.createCallback(callback);
    this.parent.send('controlTransfer', {
      bmRequestType, bRequest, wValue, wIndex, data, wLength, id,
    });
  }

  calcDecimate(requestedSampleTime: number): [number, number] {
    const decimateFactor = Math.max(1, Math.floor(requestedSampleTime / this.sampleTime));
    const sampleTime = this.sampleTime * decimateFactor;
    return [decimateFactor, sampleTime];
  }

  // --- Listener pump ---

  private pumpListeners(): void {
    for (const [id, sl] of this.smuListeners) {
      this.pumpListener(id, sl);
    }
  }

  private pumpListener(id: number, sl: StreamListener): void {
    const { updates, finished } = sl.poll();
    for (const u of updates) {
      this.listenersById[id]?.onMessage({
        _action: 'update',
        id,
        idx: u.idx,
        sampleIndex: u.sampleIndex,
        subsample: u.subsample as number,
        data: u.data,
        done: u.done,
        triggerForced: u.triggerForced,
      });
    }
    if (finished) {
      this.smuListeners.delete(id);
    }
  }

  // --- Command dispatcher (the old WS protocol surface) ---

  async handleCommand(cmd: string, m: Record<string, unknown>): Promise<Reply> {
    const driver = this.driver;

    switch (cmd) {
      case 'configure': {
        await driver.configure(
          (m.mode as number) ?? 0,
          m.sampleTime as number,
          Math.round(m.samples as number),
          !!m.continuous,
          !!m.raw,
        );
        return {};
      }

      case 'startCapture':
        await driver.startCapture();
        return {};

      case 'pauseCapture':
        await driver.pauseCapture();
        return {};

      case 'set': {
        const channel = this.requireChannel(m.channel as string);
        const source = makeSource(m as SourceDescription);
        await driver.setOutput(channel, source);
        return {};
      }

      case 'setGain': {
        const channel = this.requireChannel(m.channel as string);
        const stream = driver.findStream(m.channel as string, m.stream as string);
        await driver.setGain(channel, stream, m.gain as number);
        return {};
      }

      case 'listen': {
        const id = m.id as number;
        const streamSpecs = m.streams as Array<{ channel: string; stream: string }>;
        const t = m.trigger as
          | { type?: string; channel: string; stream: string; level: number; holdoff?: number; offset?: number; force?: number }
          | undefined;

        let trigger: SmuTriggerConfig | null = null;
        if (t) {
          if ((t.type ?? 'in') === 'in') {
            trigger = {
              type: 'in',
              stream: driver.findStream(t.channel, t.stream),
              level: t.level,
              holdoff: t.holdoff,
              offset: t.offset,
              force: t.force,
            };
          } else {
            trigger = {
              type: 'out',
              channel: this.requireChannel(t.channel),
              holdoff: t.holdoff,
              offset: t.offset,
              force: t.force,
            };
          }
        }

        const sl = new StreamListener(driver, {
          streams: streamSpecs.map((s) => driver.findStream(s.channel, s.stream)),
          decimateFactor: m.decimateFactor as number,
          start: m.start as number,
          count: m.count as number,
          trigger,
        });
        this.smuListeners.set(id, sl);
        // Connect delivered any already-buffered data immediately on listen
        this.pumpListener(id, sl);
        return {};
      }

      case 'cancelListen': {
        this.smuListeners.delete(m.id as number);
        return {};
      }

      case 'controlTransfer':
        return controlTransferCommand(driver.usb, m);

      case 'enterBootloader': {
        if (driver instanceof SmuCEEDevice) {
          await driver.enterBootloader();
        } else {
          throw new Error('enterBootloader is only supported on the CEE');
        }
        return {};
      }

      case 'readCalibration': {
        // Reply from the cached calibration, as Connect did
        if (driver instanceof SmuM1KDevice) {
          const c = driver.cal;
          return { offset: [...c.offset], gain_p: [...c.gain_p], gain_n: [...c.gain_n], valid: c.valid };
        }
        if (driver instanceof SmuCEEDevice) {
          const c = driver.cal;
          return {
            offset_a_v: c.offset_a_v, offset_a_i: c.offset_a_i,
            offset_b_v: c.offset_b_v, offset_b_i: c.offset_b_i,
            dac200_a: c.dac200_a, dac200_b: c.dac200_b,
            dac400_a: c.dac400_a, dac400_b: c.dac400_b,
            current_gain_a: c.current_gain_a, current_gain_b: c.current_gain_b,
            flags: c.flags,
          };
        }
        throw new Error('readCalibration: unsupported device');
      }

      case 'writeCalibration': {
        if (driver instanceof SmuM1KDevice) {
          await driver.writeCalibration({
            valid: true,
            offset: m.offset as number[],
            gain_p: m.gain_p as number[],
            gain_n: m.gain_n as number[],
          });
          return { status: 100 };
        }
        if (driver instanceof SmuCEEDevice) {
          const num = (k: string, dflt?: number): number => {
            const v = m[k];
            if (v == null) {
              if (dflt === undefined) throw new Error(`writeCalibration: missing ${k}`);
              return dflt;
            }
            return v as number;
          };
          await driver.writeCalibration({
            magic: 0, // set by the driver
            offset_a_v: num('offset_a_v'), offset_a_i: num('offset_a_i'),
            offset_b_v: num('offset_b_v'), offset_b_i: num('offset_b_i'),
            dac200_a: num('dac200_a'), dac200_b: num('dac200_b'),
            dac400_a: num('dac400_a'), dac400_b: num('dac400_b'),
            current_gain_a: num('current_gain_a', 0xffffffff),
            current_gain_b: num('current_gain_b', 0xffffffff),
            flags: num('flags', 0xff),
          });
          return { status: 25 };
        }
        throw new Error('writeCalibration: unsupported device');
      }

      case 'tempCalibration': {
        if (driver instanceof SmuCEEDevice) {
          driver.tempCalibration({
            offset_a_v: (m.offset_a_v as number) ?? 0,
            offset_a_i: (m.offset_a_i as number) ?? 0,
            offset_b_v: (m.offset_b_v as number) ?? 0,
            offset_b_i: (m.offset_b_i as number) ?? 0,
          });
        }
        return {};
      }

      case 'getPower': {
        const p = await this.m1k().readPower();
        return { power: { status_raw: p.statusRaw, alert_bit: p.alertBit, overcurrent: p.overcurrent } };
      }

      case 'getTemperature': {
        const t = await this.m1k().readTemperature();
        return { temperature: { a: t.a, b: t.b } };
      }

      case 'getFrontend':
        return { frontend: this.frontendReply() };

      case 'setFrontend': {
        const m1k = this.m1k();
        const ch: 0 | 1 = m.channel === 'b' || m.channel === 'B' ? 1 : 0;

        const switches: M1KFrontendSwitch[] = ['r50_2v5', 'r50_gnd', 'feedback', 'output_en', 'split'];
        for (const name of switches) {
          if (m[name] != null) {
            await m1k.setFrontendSwitch(ch, name, !!m[name]);
          }
        }

        const potR1 = (m.pot_r1 as number) ?? -1;
        const potR2 = (m.pot_r2 as number) ?? -1;
        if (potR1 >= 0 || potR2 >= 0) {
          const fe = m1k.frontend[ch];
          await m1k.setDigipot(
            ch,
            potR1 >= 0 ? potR1 & 0x7f : fe.pot_r1,
            potR2 >= 0 ? potR2 & 0x7f : fe.pot_r2,
          );
        }

        return { frontend: this.frontendReply() };
      }

      case 'getLED':
        return { leds: this.ledReply() };

      case 'setLED': {
        const m1k = this.m1k();
        const val = (m.leds as number) ?? -1;
        if (val >= 0) {
          await m1k.setLEDs(val & 0x7);
        } else {
          let state = m1k.ledState;
          const bit = (key: string, mask: number): void => {
            if (m[key] != null) {
              if (m[key]) state |= mask;
              else state &= ~mask;
            }
          };
          bit('red', 0x4);
          bit('green', 0x2);
          bit('blue', 0x1);
          await m1k.setLEDs(state);
        }
        return { leds: this.ledReply() };
      }

      case 'setSerial': {
        const s = (m.serial as string) ?? '';
        await this.m1k().setSerial(s);
        return { status: s.length };
      }

      default:
        throw new Error(`Unknown command: ${cmd}`);
    }
  }

  private requireChannel(id: string): SmuChannel {
    const c = this.driver.channelById(id);
    if (!c) throw new Error(`Channel not found: ${id}`);
    return c;
  }

  private m1k(): SmuM1KDevice {
    if (!(this.driver instanceof SmuM1KDevice)) {
      throw new Error('Command is only supported on the M1K');
    }
    return this.driver;
  }

  private frontendReply(): Reply {
    const m1k = this.m1k();
    const ch = (i: 0 | 1): Reply => {
      const fe = m1k.frontend[i];
      return {
        r50_2v5: fe.r50_2v5,
        r50_gnd: fe.r50_gnd,
        feedback: fe.feedback,
        output_en: fe.output_en,
        split: fe.split,
        pot: [fe.pot_r1, fe.pot_r2],
      };
    };
    return { a: ch(0), b: ch(1) };
  }

  private ledReply(): Reply {
    const m1k = this.m1k();
    const l = m1k.leds;
    return { leds: m1k.ledState, red: l.red, green: l.green, blue: l.blue };
  }
}

/** Shared `controlTransfer` command, used by both device wrappers */
async function controlTransferCommand(
  usb: { controlIn(t: number, r: number, v: number, i: number, l: number): Promise<DataView>; controlOut(t: number, r: number, v: number, i: number, d?: BufferSource): Promise<number> },
  m: Record<string, unknown>,
): Promise<Reply> {
  const bmRequestType = (m.bmRequestType as number) ?? 0xc0;
  const bRequest = m.bRequest as number;
  const wValue = (m.wValue as number) ?? 0;
  const wIndex = (m.wIndex as number) ?? 0;

  try {
    if (bmRequestType & 0x80) {
      let wLength = (m.wLength as number) ?? 64;
      if (wLength > 64) wLength = 64;
      if (wLength < 0) wLength = 0;
      const d = await usb.controlIn(bmRequestType, bRequest, wValue, wIndex, wLength);
      const data: number[] = [];
      for (let i = 0; i < d.byteLength; i++) data.push(d.getUint8(i));
      return { data, status: d.byteLength };
    } else {
      const src = m.data;
      let bytes: Uint8Array<ArrayBuffer>;
      if (Array.isArray(src)) {
        bytes = Uint8Array.from(src as number[]);
      } else if (typeof src === 'string') {
        bytes = Uint8Array.from(src, (c) => c.charCodeAt(0) & 0xff);
      } else {
        bytes = new Uint8Array(0);
      }
      const written = await usb.controlOut(bmRequestType, bRequest, wValue, wIndex, bytes);
      return { status: written };
    }
  } catch (e) {
    console.error('controlTransfer failed:', e);
    return { status: -1 };
  }
}

// --- Channel ---

export class Channel {
  id: string;
  displayName: string;
  streams: Record<string, Stream> = {};
  source: OutputSource;
  removed = new TypedEvent();
  outputChanged = new TypedEvent<[OutputSource]>();

  constructor(info: ChannelInfo, public parent: CEEDevice) {
    this.id = info.id;
    this.displayName = info.displayName;
    this.source = info.output;

    for (const [streamId, streamInfo] of Object.entries(info.streams)) {
      this.streams[streamId] = new Stream(streamInfo, this);
    }
  }

  onRemoved(): void {
    for (const stream of Object.values(this.streams)) {
      stream.onRemoved();
    }
    this.removed.notify();
  }

  set(mode: string | number, source: string, dict: Record<string, unknown>, cb?: (s: OutputSource) => void): void {
    dict['mode'] = mode;
    dict['source'] = source;
    this.setDirect(dict, cb);
  }

  setDirect(dict: Record<string, unknown>, cb?: (s: OutputSource) => void): void {
    dict.channel = this.id;

    if (dict.dutyCycleHint) {
      dict.hint = `dutycycle:${dict.dutyCycleHint}`;
      delete dict.dutyCycleHint;
    }

    server.send('set', dict);
    if (cb) {
      const fn = (s: OutputSource) => {
        if ((s as Record<string, unknown>).effective) {
          this.outputChanged.unListen(fn);
          cb(s);
        }
      };
      this.outputChanged.subscribe(fn);
    }
  }

  setAdjust(dict: string | Record<string, unknown>, val?: unknown): void {
    const KEEP_ATTRS = ['mode', 'source', 'value', 'high', 'low', 'highSamples', 'lowSamples', 'offset', 'amplitude', 'period'] as const;
    const d: Record<string, unknown> = {};
    for (const attr of KEEP_ATTRS) {
      if (this.source[attr] != null) d[attr] = this.source[attr];
    }

    if (typeof dict === 'string' && val != null) {
      d[dict] = val;
    } else if (typeof dict === 'object') {
      for (const [k, v] of Object.entries(dict)) {
        d[k] = v;
      }
    }

    this.setDirect(d);
  }

  setConstant(mode: string | number, val: number, cb?: (s: OutputSource) => void): void {
    this.setDirect({ mode, source: 'constant', value: val }, cb);
  }

  setPeriodic(mode: string | number, source: string, freq: number, offset: number, amplitude: number, cb?: (s: OutputSource) => void): void {
    this.setDirect({
      mode, source,
      period: 1 / freq / this.parent.sampleTime,
      offset, amplitude,
    }, cb);
  }

  guessSourceOptions(sourceType: string): void {
    const m = this.source.mode;
    let value = 2.5;
    let period = Math.round(0.5 / this.parent.sampleTime);
    let amplitude = 1;

    switch (this.source.source) {
      case 'constant':
        value = this.source.value ?? 2.5;
        break;
      case 'sine': case 'triangle': case 'square':
        value = this.source.offset ?? 2.5;
        period = this.source.period ?? period;
        amplitude = this.source.amplitude ?? 1;
        break;
      case 'adv_square':
        value = ((this.source.high ?? 0) + (this.source.low ?? 0)) / 2;
        period = (this.source.highSamples ?? 0) + (this.source.lowSamples ?? 0);
        amplitude = ((this.source.high ?? 0) - (this.source.low ?? 0)) / 2;
        break;
      case 'arb':
        period = this.source.period ?? period;
        break;
    }

    switch (sourceType) {
      case 'constant':
        this.setConstant(m, value);
        break;
      case 'sine': case 'triangle': case 'square':
        this.set(m, sourceType, { offset: value, amplitude, period });
        break;
      case 'adv_square':
        this.set(m, sourceType, {
          high: value + amplitude, low: value - amplitude,
          highSamples: period / 2, lowSamples: period / 2,
        });
        break;
    }
  }

  onOutputChanged(m: OutputSource): void {
    this.source = m;

    if (m.source === 'adv_square') {
      const match = /dutycycle:([\d.]+)/.exec(m.hint ?? '');
      m.dutyCycleHint = match
        ? parseFloat(match[1])
        : (m.highSamples ?? 0) / ((m.highSamples ?? 0) + (m.lowSamples ?? 0));
    }

    this.outputChanged.notify(m);
  }
}

// --- Stream ---

export class Stream {
  id: string;
  displayName: string;
  units: string;
  min: number;
  max: number;
  outputMode: string | number;
  gain: number;
  uncertainty: number;
  digits: number;

  removed = new TypedEvent();
  gainChanged = new TypedEvent<[number]>();

  constructor(info: StreamInfo, public parent: Channel) {
    this.id = info.id;
    this.displayName = info.displayName;
    this.units = info.units;
    this.min = info.min;
    this.max = info.max;
    this.outputMode = info.outputMode;
    this.gain = info.gain;
    this.uncertainty = info.uncertainty;
    this.digits = Math.round(-Math.log(Math.max(this.uncertainty, 0.0001)) / Math.LN10);
  }

  onGain(gain: number): void {
    this.gain = gain;
    this.gainChanged.notify(this.gain);
  }

  setGain(g: number): void {
    if (g !== this.gain) {
      server.send('setGain', {
        channel: this.parent.id,
        stream: this.id,
        gain: g,
      });
    }
  }

  onRemoved(): void {
    this.removed.notify();
  }

  getSample(t = 0.01, cb: (val: number) => void): void {
    const l = new Listener(this.parent.parent, [this]);
    l.configure(false, t, 1);
    l.submit();
    l.updated.subscribe((m) => {
      cb(m.data[0][0]);
    });
  }

  isSource(): boolean {
    // eslint-disable-next-line eqeqeq -- mode may be a number or string
    return this.parent.source.mode == this.outputMode;
  }

  sourceLevel(): number {
    const source = this.parent.source;
    switch (source.source) {
      case 'constant':
        return source.value ?? 0;
      case 'sine': case 'triangle': case 'square':
        return source.offset ?? 0;
      case 'adv_square':
        return ((source.high ?? 0) + (source.low ?? 0)) / 2;
      default:
        return (this.min + this.max) / 2;
    }
  }
}

// --- Global server instance ---

export const server = new Dataserver('webusb');

// --- Listener ---

let nextListenerId = 100;

export interface UpdateMessage {
  _action: 'update';
  id: number;
  idx: number;
  sampleIndex: number;
  subsample: number;
  data: (number[] | Float32Array)[];
  done: boolean;
  triggerForced?: boolean;
}

export class Listener {
  id: number;
  updated = new TypedEvent<[UpdateMessage]>();
  reset = new TypedEvent();
  done = new TypedEvent();
  trigger: { stream: Stream; level: number; holdoff: number; offset: number; force: number; type: string } | false = false;

  decimateFactor = 1;
  sampleTime = 0;
  count = -1;
  needsReset = false;
  protected startSample = 0;

  constructor(public device: CEEDevice, public streams: Stream[]) {
    this.id = nextListenerId++;
    this.device.listenersById[this.id] = this;
  }

  streamIndex(stream: Stream): number {
    return this.streams.indexOf(stream);
  }

  configure(startTime: number | false | null = null, requestedSampleTime = 0.1, count = -1): void {
    this.count = count;
    if (!(requestedSampleTime > 0)) {
      console.error('Invalid sample time', requestedSampleTime);
      return;
    }

    [this.decimateFactor, this.sampleTime] = this.device.calcDecimate(requestedSampleTime);
    console.assert(this.decimateFactor > 0);

    if (startTime !== null) {
      if (startTime === false) {
        this.startSample = -1;
      } else {
        this.startSample = Math.floor(startTime / this.device.sampleTime) - this.decimateFactor;
      }
    } else {
      this.startSample = -this.decimateFactor - 2;
    }
  }

  disableTrigger(): void {
    this.trigger = false;
  }

  configureTrigger(stream: Stream, level: number, holdoff = 0, offset = 0, force = 0, type = 'in'): void {
    this.trigger = { stream, level, holdoff, offset, force, type };
  }

  submit(): void {
    const msg: Record<string, unknown> = {
      id: this.id,
      streams: this.streams.map(s => ({ channel: s.parent.id, stream: s.id })),
      decimateFactor: this.decimateFactor,
      start: this.startSample,
      count: this.count,
    };

    if (this.trigger) {
      msg.trigger = {
        type: this.trigger.type ?? 'in',
        channel: this.trigger.stream.parent.id,
        stream: this.trigger.stream.id,
        level: this.trigger.level,
        holdoff: Math.round(this.trigger.holdoff / this.device.sampleTime),
        offset: Math.ceil(this.trigger.offset / this.device.sampleTime),
        force: Math.round(this.trigger.force / this.device.sampleTime),
      };
    }

    this.device.parent.send('listen', msg);
    this.needsReset = true;
  }

  onReset(): void {
    this.reset.notify();
  }

  onMessage(m: UpdateMessage): void {
    this.updated.notify(m);
    if (m.done) {
      this.done.notify();
    }
  }

  cancel(): void {
    this.device.parent.send('cancelListen', { id: this.id });
    delete this.device.listenersById[this.id];
  }
}

// --- DataListener (extends Listener with buffering) ---

export class DataListener extends Listener {
  xdata: Float32Array = new Float32Array(0);
  data: Float32Array[];
  requestedPoints = 0;
  sweepDone = new TypedEvent();
  doneSamples = 0;

  xmin = 0;
  xmax = 0;
  continuous = true;
  protected len = 0;
  private subsample = 0;
  private validCount = 0;
  private sweepEnd = 0;

  constructor(device: CEEDevice, streams: Stream[]) {
    super(device, streams);
    this.data = streams.map(() => new Float32Array(0));
  }

  override configure(
    xmin: number | false | null = null,
    xmax_or_sampleTime?: number,
    requestedPoints_or_count?: number,
    continuous = true,
  ): void {
    // DataListener.configure(xmin, xmax, requestedPoints, continuous)
    // vs Listener.configure(startTime, requestedSampleTime, count)
    // DataListener always passes numbers for first two args
    if (typeof xmin === 'number' && xmax_or_sampleTime !== undefined) {
      this.xmin = xmin;
      this.xmax = xmax_or_sampleTime;
      this.requestedPoints = requestedPoints_or_count ?? 0;
      this.continuous = continuous;

      const time = this.xmax - this.xmin;
      const requestedSampleTime = time / this.requestedPoints;

      if (this.trigger) {
        super.configure(-time, requestedSampleTime);
        this.trigger.offset = this.xmin;
        this.count = this.len = Math.ceil(time / this.sampleTime) + 4;
        this.xmin = Math.ceil(this.xmin / this.sampleTime) * this.sampleTime;
        this.xmax = this.xmin + time;
      } else {
        super.configure(this.xmin, requestedSampleTime);
        this.len = Math.ceil(time / this.sampleTime);
        this.count = (this.xmin < 0 && this.xmax === 0 && this.continuous) ? -1 : this.len;
      }
    } else {
      // Fallback to parent signature
      super.configure(xmin, xmax_or_sampleTime, requestedPoints_or_count);
    }
  }

  override onMessage(m: UpdateMessage): void {
    if (m.idx === 0) {
      // sweepStartSample available if needed: m.sampleIndex
      // CEE's ADC pipeline reports trigger positions 2 samples early; the
      // M1K's captured data is phase-aligned as-is (measured ≤0.3 samples).
      // 2 samples is 72° of phase at 10 kHz, so this must be per-device.
      const pipeline = this.device.model === 'com.analogdevices.m1k' ? 0 : 2.0;
      this.subsample = (m.subsample + pipeline) * this.device.sampleTime || 0;

      if (this.needsReset) {
        console.assert(this.len > 0);
        this.needsReset = false;
        this.validCount = 0;
        this.sweepEnd = 0;
        this.xdata = new Float32Array(this.len);

        for (let i = 0; i < this.len; i++) {
          this.xdata[i] = this.xmin + i * this.sampleTime - this.subsample;
        }

        this.data = this.streams.map(() => new Float32Array(this.len));
        this.reset.notify();
      }
    }

    for (let i = 0; i < this.streams.length; i++) {
      const src = m.data[i];
      const dest = this.data[i];
      let idx = m.idx;

      if (src.length && this.xmin < 0 && !this.trigger) {
        // Shift array left for scrolling
        dest.set(dest.subarray(src.length));
        idx = dest.length - src.length;
      }

      for (const val of src) {
        dest[idx++] = val;
      }
    }

    const endIdx = m.data[0].length + m.idx;

    for (let j = m.idx; j < endIdx; j++) {
      this.xdata[j] = this.xmin + j * this.sampleTime - this.subsample;
    }

    this.validCount = Math.min(this.len, this.validCount + m.data[0].length);
    this.sweepEnd = Math.max(this.sweepEnd, Math.min(endIdx, this.len));

    this.doneSamples = this.decimateFactor * endIdx;

    if (endIdx >= this.len) {
      this.sweepDone.notify();
    }

    super.onMessage(m);
  }

  // Index range [start, end) of this.data that has been filled with real
  // samples; the rest of the buffer is zero-initialized padding.
  validRange(): [number, number] {
    if (this.xmin < 0 && !this.trigger) {
      // Scrolling mode: data shifts left, newest samples at the end
      return [Math.max(0, this.len - this.validCount), this.len];
    }
    return [0, this.sweepEnd];
  }
}

// --- Bootloader Device ---

export class BootloaderDevice {
  changed = new TypedEvent<[BootloaderDevice]>();
  removed = new TypedEvent();

  serial = '';
  magic = '';
  version = '';
  devid = '';
  page_size = 0;
  app_section_end = 0;
  hw_product = '';
  hw_version = '';

  private disposed = false;

  constructor(public parent: Dataserver, public readonly driver: SmuBootloaderDevice) {
    // Deliver info after the caller has subscribed `changed` (mirrors the
    // async WS 'info' message)
    queueMicrotask(() => {
      if (!this.disposed) this.onInfo();
    });
  }

  dispose(): void {
    this.disposed = true;
  }

  private onInfo(): void {
    const info = this.driver.info;
    this.serial = removeNull(this.driver.serial);
    this.magic = toHex(bswap32(info.magic));
    this.version = String(info.version);
    this.devid = toHex(bswap32(info.devid));
    this.page_size = info.pageSize;
    this.app_section_end = info.appSectionEnd;
    this.hw_product = removeNull(info.hwProduct);
    this.hw_version = removeNull(info.hwVersion);
    this.changed.notify(this);
  }

  onRemoved(): void {
    this.removed.notify();
  }

  async handleCommand(cmd: string, m: Record<string, unknown>): Promise<Reply> {
    switch (cmd) {
      case 'erase':
        await this.driver.erase();
        return {};
      case 'write': {
        const data = m.data as number[];
        await this.driver.write(Uint8Array.from(data));
        return { result: 0 };
      }
      case 'crc_app':
        return { crc: await this.driver.crcApp() };
      case 'crc_boot':
        return { crc: await this.driver.crcBoot() };
      case 'reset':
        await this.driver.reset();
        return {};
      case 'controlTransfer':
        return controlTransferCommand(this.driver.usb, m);
      default:
        throw new Error(`Unknown bootloader command: ${cmd}`);
    }
  }

  crcApp(callback: Callback): void {
    this.parent.send('crc_app', { id: this.parent.createCallback(callback) });
  }

  crcBoot(callback: Callback): void {
    this.parent.send('crc_boot', { id: this.parent.createCallback(callback) });
  }

  erase(callback: Callback): void {
    this.parent.send('erase', { id: this.parent.createCallback(callback) });
  }

  write(data: number[], callback: Callback): void {
    this.parent.send('write', { id: this.parent.createCallback(callback), data });
  }

  reset(): void {
    this.parent.send('reset');
  }
}
