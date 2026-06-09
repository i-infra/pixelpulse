/**
 * WebSocket interface to Nonolith Connect dataserver
 * Ported from dataserver.coffee
 * Original: (C) 2011 Nonolith Labs, Kevin Mehall <km@kevinmehall.net>
 * Distributed under the terms of the GNU LGPLv3
 */

// --- Typed event emitter ---

export class TypedEvent<T extends unknown[] = []> {
  private listeners: Array<(...args: T) => void> = [];

  subscribe(func: (...args: T) => void): void {
    this.listeners.push(func);
  }

  listen = this.subscribe;

  unListen(func: (...args: T) => void): void {
    const i = this.listeners.indexOf(func);
    if (i !== -1) this.listeners.splice(i, 1);
  }

  notify(...args: T): void {
    for (const func of this.listeners) {
      func(...args);
    }
  }
}

// --- WebSocket message types ---

/** Messages sent from client to server */
export type ClientCommand =
  | { _cmd: 'selectDevice'; id: string }
  | { _cmd: 'configure'; mode: number; sampleTime: number; continuous: boolean; raw: boolean; samples?: number }
  | { _cmd: 'startCapture' }
  | { _cmd: 'pauseCapture' }
  | { _cmd: 'set'; channel: string; mode?: string; source?: string; [key: string]: unknown }
  | { _cmd: 'setGain'; channel: string; stream: string; gain: number }
  | { _cmd: 'listen'; id: number; streams: Array<{ channel: string; stream: string }>; decimateFactor: number; start: number; count: number; trigger?: TriggerConfig | false }
  | { _cmd: 'cancelListen'; id: number }
  | { _cmd: 'controlTransfer'; bmRequestType: number; bRequest: number; wValue: number; wIndex: number; data: number[]; wLength: number; id: number | string }
  | { _cmd: 'crc_app'; id: number | string }
  | { _cmd: 'crc_boot'; id: number | string }
  | { _cmd: 'erase'; id: number | string }
  | { _cmd: 'write'; id: number | string; data: number[] }
  | { _cmd: 'reset' };

/** Messages received from server, discriminated on _action */
export type ServerMessage =
  | { _action: 'serverHello'; version: string; gitVersion: string }
  | { _action: 'devices'; devices: Record<string, DeviceInfo> }
  | { _action: 'deviceDisconnected' }
  | { _action: 'return'; id: number; [key: string]: unknown }
  | { _action: 'deviceConfig'; device: CEEDeviceInfo }
  | { _action: 'captureState'; state: string; done: boolean }
  | { _action: 'captureReset' }
  | { _action: 'update'; id: number; idx: number; sampleIndex: number; subsample: number; data: number[][]; done: boolean }
  | { _action: 'outputChanged'; channel: string; source: string; mode: string; [key: string]: unknown }
  | { _action: 'gainChanged'; channel: string; stream: string; gain: number }
  | { _action: 'packetDrop' }
  | { _action: 'info'; [key: string]: unknown };

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
  captureState: string;
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
  outputMode: string;
  gain: number;
  uncertainty: number;
}

export interface OutputSource {
  mode: string;
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

// --- Helper ---

function removeNull(val: string | undefined | null): string {
  return val ? val.replace(/\0/g, '') : '';
}

// --- Dataserver ---

export class Dataserver {
  connected = new TypedEvent();
  disconnected = new TypedEvent();
  devicesChanged = new TypedEvent<[Device[]]>();

  devices: Device[] = [];
  device: CEEDevice | BootloaderDevice | null = null;
  version = '';
  gitVersion = '';

  private ws: WebSocket | null = null;
  private callbacks: Record<number | string, (data: Record<string, unknown>) => void> = {};

  constructor(public host: string) {}

  connect(): void {
    this.ws = new WebSocket(`ws://${this.host}/ws/v0`);

    this.ws.onopen = () => {
      console.log('connected');
      this.connected.notify();
    };

    this.ws.onclose = () => {
      console.log('disconnected');
      this.disconnected.notify();
    };

    this.ws.onmessage = (evt: MessageEvent) => {
      let m: ServerMessage;
      try {
        m = JSON.parse(evt.data as string);
      } catch {
        console.log('Invalid JSON frame:', evt.data);
        return;
      }

      switch (m._action) {
        case 'serverHello':
          this.version = m.version.replace(/^V/, '');
          this.gitVersion = m.gitVersion;
          console.log('server', this.version);
          break;

        case 'devices':
          this.devices = Object.values(m.devices).map(
            (info) => new Device(info),
          );
          this.devicesChanged.notify(this.devices);
          break;

        case 'deviceDisconnected': {
          const d = this.device;
          this.device = null;
          d?.removed.notify();
          break;
        }

        case 'return':
          this.runCallback(m.id, m as unknown as Record<string, unknown>);
          break;

        default:
          this.device?.onMessage(m);
      }
    };
  }

  send(cmd: string, m: Record<string, unknown> = {}): void {
    m._cmd = cmd;
    this.ws!.send(JSON.stringify(m));
  }

  selectDevice(device: Device): CEEDevice | BootloaderDevice {
    this.send('selectDevice', { id: device.id });
    if (this.device) {
      (this.device as CEEDevice).onRemoved?.();
    }
    this.device = device.makeActiveObj(this);
    return this.device;
  }

  createCallback(fn?: (data: Record<string, unknown>) => void): number | string {
    if (fn) {
      const id = (+new Date() + Math.round(Math.random() * 100000)) & 0xfffffff;
      this.callbacks[id] = fn;
      return id;
    }
    return '';
  }

  private runCallback(id: number | string, data: Record<string, unknown>, remove = true): void {
    if (this.callbacks[id]) {
      this.callbacks[id](data);
      if (remove) delete this.callbacks[id];
    }
  }
}

// --- Device (from device list, before selection) ---

export class Device {
  id: string;
  model: string;
  serial: string;
  hwVersion: string;
  fwVersion: string;

  constructor(info: DeviceInfo) {
    this.id = info.id;
    this.model = info.model;
    this.serial = info.serial;
    this.hwVersion = removeNull(info.hwVersion);
    this.fwVersion = removeNull(info.fwVersion);
  }

  makeActiveObj(parent: Dataserver): CEEDevice | BootloaderDevice {
    switch (this.model) {
      case 'com.nonolithlabs.cee':
        return new CEEDevice(parent);
      case 'com.nonolithlabs.bootloader':
        return new BootloaderDevice(parent);
      default:
        throw new Error(`Unknown device model: ${this.model}`);
    }
  }
}

// --- CEE Device (active, selected device) ---

export class CEEDevice {
  changed = new TypedEvent<[CEEDevice]>();
  removed = new TypedEvent();
  captureStateChanged = new TypedEvent<[string]>();
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
  captureState = '';
  captureDone = false;
  mode = 0;
  samples = 0;
  raw = false;
  minSampleTime = 1 / 40e3;
  hasOutTrigger = false;
  hasAdvSquare = false;

  constructor(public parent: Dataserver) {}

  onMessage(m: ServerMessage): void {
    switch (m._action) {
      case 'deviceConfig':
        this.onInfo(m.device);
        break;
      case 'captureState':
        this.captureState = m.state;
        this.captureDone = m.done;
        this.captureStateChanged.notify(this.captureState);
        break;
      case 'captureReset':
        this.samplesReset.notify();
        for (const id in this.listenersById) {
          this.listenersById[id].onReset();
        }
        break;
      case 'update':
        this.listenersById[m.id]?.onMessage(m);
        break;
      case 'outputChanged':
        this.channels[m.channel]?.onOutputChanged(m as unknown as OutputSource);
        break;
      case 'gainChanged':
        this.channels[m.channel]?.streams[m.stream]?.onGain(m.gain);
        break;
      case 'packetDrop':
        console.log('dropped packet');
        break;
    }
  }

  onInfo(info: CEEDeviceInfo): void {
    this.id = info.id;
    this.model = info.model;
    this.serial = info.serial;
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

    this.listenersById = {};
    this.hasOutTrigger = this.parent.version >= '1.2' && this.fwVersion >= '1.2';
    this.hasAdvSquare = this.parent.version >= '1.2';

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
    callback?: (data: Record<string, unknown>) => void,
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

  set(mode: string, source: string, dict: Record<string, unknown>, cb?: (s: OutputSource) => void): void {
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

  setConstant(mode: string, val: number, cb?: (s: OutputSource) => void): void {
    this.setDirect({ mode, source: 'constant', value: val }, cb);
  }

  setPeriodic(mode: string, source: string, freq: number, offset: number, amplitude: number, cb?: (s: OutputSource) => void): void {
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
  outputMode: string;
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
    return this.parent.source.mode === this.outputMode;
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

export const server = new Dataserver('localhost:9003');

// --- Listener ---

let nextListenerId = 100;

export interface UpdateMessage {
  _action: 'update';
  id: number;
  idx: number;
  sampleIndex: number;
  subsample: number;
  data: number[][];
  done: boolean;
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
      this.subsample = (m.subsample + 2.0) * this.device.sampleTime || 0;

      if (this.needsReset) {
        console.assert(this.len > 0);
        this.needsReset = false;
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

    this.doneSamples = this.decimateFactor * endIdx;

    if (endIdx >= this.len) {
      this.sweepDone.notify();
    }

    super.onMessage(m);
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

  constructor(public parent: Dataserver) {}

  onMessage(m: ServerMessage): void {
    if (m._action === 'info') {
      this.onInfo(m as unknown as Record<string, unknown>);
    }
  }

  onInfo(info: Record<string, unknown>): void {
    this.serial = info.serial as string ?? '';
    this.magic = info.magic as string ?? '';
    this.version = info.version as string ?? '';
    this.devid = info.devid as string ?? '';
    this.page_size = info.page_size as number ?? 0;
    this.app_section_end = info.app_section_end as number ?? 0;
    this.hw_product = removeNull(info.hw_product as string);
    this.hw_version = removeNull(info.hw_version as string);
    this.changed.notify(this);
  }

  onRemoved(): void {
    this.removed.notify();
  }

  crcApp(callback: (data: Record<string, unknown>) => void): void {
    this.parent.send('crc_app', { id: this.parent.createCallback(callback) });
  }

  crcBoot(callback: (data: Record<string, unknown>) => void): void {
    this.parent.send('crc_boot', { id: this.parent.createCallback(callback) });
  }

  erase(callback: (data: Record<string, unknown>) => void): void {
    this.parent.send('erase', { id: this.parent.createCallback(callback) });
  }

  write(data: number[], callback: (data: Record<string, unknown>) => void): void {
    this.parent.send('write', { id: this.parent.createCallback(callback), data });
  }

  reset(): void {
    this.parent.send('reset');
  }
}
