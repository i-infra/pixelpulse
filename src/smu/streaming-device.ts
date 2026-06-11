/**
 * Streaming device base class.
 *
 * Port of connect/streaming_device/streaming_device.{hpp,cpp}: the capture
 * state machine and per-stream sample ring buffers. The Connect server's
 * listener/decimation machinery (stream_listener.cpp) is intentionally not
 * ported: consumers run in-process, so they subscribe to the `data` event
 * and read the ring buffers directly via get()/resample().
 */

import { TypedEvent } from './events';
import { OutputSource } from './output-source';
import { UsbTransport } from './usb';

export class Stream {
  state = '';

  /** mode for output that "sources" this stream's variable; 0 if not supported */
  readonly outputMode: number;

  /** Internal device gain factor */
  gain: number;

  /** Default gain factor */
  readonly normalGain: number;

  uncertainty: number;

  /** Raw sample ring buffer (length = captureSamples) */
  data: Float32Array | null = null;

  constructor(
    public readonly id: string,
    public readonly displayName: string,
    public units: string,
    public min: number,
    public max: number,
    outputMode = 0,
    uncertainty = 0,
    gain = 1,
  ) {
    this.outputMode = outputMode;
    this.gain = gain;
    this.normalGain = gain;
    this.uncertainty = uncertainty;
  }

  getGain(): number {
    return this.gain / this.normalGain;
  }

  /** Allocate space for `size` samples */
  allocate(size: number): void {
    this.data = new Float32Array(size);
  }
}

export class Channel {
  streams: Stream[] = [];
  source: OutputSource | null = null;

  constructor(public readonly id: string, public readonly displayName: string) {}

  streamById(id: string): Stream | null {
    return this.streams.find((s) => s.id === id) ?? null;
  }
}

export interface DeviceInfo {
  model: string;
  hwVersion: string;
  fwVersion: string;
  serial: string;
}

export abstract class StreamingDevice {
  // --- Events (replace Connect's broadcast JSON notifications) ---

  /** Configuration changed (channels/streams reallocated) */
  configChanged = new TypedEvent<[StreamingDevice]>();
  /** Capture started/paused/finished: (running, done) */
  captureStateChanged = new TypedEvent<[boolean, boolean]>();
  /** Capture time reset to 0 */
  captureReset = new TypedEvent();
  /** New samples are available in the stream buffers */
  data = new TypedEvent<[StreamingDevice]>();
  /** A channel's output source changed */
  outputChanged = new TypedEvent<[Channel, OutputSource]>();
  /** A stream's gain changed */
  gainChanged = new TypedEvent<[Channel, Stream, number]>();
  /** The device reported a dropped packet */
  packetDrop = new TypedEvent();
  /** Unrecoverable streaming error */
  error = new TypedEvent<[Error]>();
  /** Device unplugged */
  disconnected = new TypedEvent();

  // --- Capture state ---

  devMode = 0;
  rawMode = false;

  /** True if capturing */
  captureState = false;

  /** True if the capture is completed */
  captureDone = false;

  captureLength = 0;

  /** Number of samples in current capture; allocated size of stream.data */
  captureSamples = 0;

  /** True if configured for continuous (ring buffer) sampling */
  captureContinuous = false;

  /** Time of a sample */
  sampleTime: number;

  /** Minimum allowed sampleTime */
  minSampleTime = 0;

  /** IN sample counter; index of next-written element is capture_i % captureSamples */
  capture_i = 0;

  /** OUT sample counter */
  capture_o = 0;

  channels: Channel[] = [];

  protected constructor(sampleTime: number) {
    this.sampleTime = sampleTime;
  }

  abstract readonly usb: UsbTransport;

  abstract get model(): string;
  abstract get hwVersion(): string;
  abstract get fwVersion(): string;
  abstract get serial(): string;

  get info(): DeviceInfo {
    return {
      model: this.model,
      hwVersion: this.hwVersion,
      fwVersion: this.fwVersion,
      serial: this.serial,
    };
  }

  /**
   * Configure the device for the specified `mode` and allocate resources to
   * capture `samples` samples at `sampleTime` seconds/sample. If
   * `continuous`, capture indefinitely, keeping `samples` of history. If
   * `raw`, units are device LSB rather than standard units.
   */
  abstract configure(mode: number, sampleTime: number, samples: number, continuous: boolean, raw: boolean): Promise<void>;

  /** Set time = 0 */
  async resetCapture(): Promise<void> {
    this.captureDone = false;
    this.capture_i = 0;
    this.capture_o = 0;
    await this.onResetCapture();
    this.captureReset.notify();
  }

  /** Start capturing */
  async startCapture(): Promise<void> {
    if (!this.captureState) {
      if (this.captureDone) await this.resetCapture();
      await this.onStartCapture();
      this.captureState = true;
      this.captureStateChanged.notify(this.captureState, this.captureDone);
    }
  }

  /** Pause capturing */
  async pauseCapture(): Promise<void> {
    if (this.captureState) {
      this.captureState = false;
      await this.onPauseCapture();
      this.captureStateChanged.notify(this.captureState, this.captureDone);
    }
  }

  protected async doneCapture(): Promise<void> {
    this.captureDone = true;
    if (this.captureState) {
      this.captureState = false;
      await this.onPauseCapture();
    }
    this.captureStateChanged.notify(this.captureState, this.captureDone);
  }

  async setOutput(channel: Channel, source: OutputSource): Promise<void> {
    source.initialize(this.capture_o, channel.source);
    channel.source = source;
    channel.source.startSample = this.capture_o;
    this.outputChanged.notify(channel, source);
  }

  protected async setInternalGain(_channel: Channel, _stream: Stream, _gain: number): Promise<void> {}

  async setGain(c: Channel, s: Stream, gain: number): Promise<void> {
    await this.setInternalGain(c, s, Math.round(gain * s.normalGain));
  }

  channelById(id: string): Channel | null {
    return this.channels.find((c) => c.id === id) ?? null;
  }

  /** Find a stream by its channel id and stream id */
  findStream(channelId: string, streamId: string): Stream {
    const c = this.channelById(channelId);
    if (!c) throw new Error('Channel not found');
    const s = c.streamById(streamId);
    if (!s) throw new Error('Stream not found');
    return s;
  }

  /** CEE-specific, here for API parity with Connect */
  currentLimit = 0;
  async setCurrentLimit(_limit: number): Promise<void> {}

  // --- Sample buffer access ---

  /**
   * Store a sample to a stream.
   * Note: when you are done putting samples, call sampleDone();
   */
  protected put(s: Stream, p: number): void {
    if (!s.data || !this.captureSamples || (this.capture_i >= this.captureSamples && !this.captureContinuous)) return;
    s.data[this.capture_i % this.captureSamples] = p;
  }

  /**
   * Get the sample corresponding to buffer index i. If it is not in memory
   * (either overwritten or not yet collected), returns NaN.
   */
  get(s: Stream, i: number): number {
    if (
      !s.data || !this.captureSamples // not prepared
      || i >= this.capture_i // not yet collected
      || (this.capture_i > this.captureSamples && i <= this.capture_i - this.captureSamples) // overwritten
    ) {
      return NaN;
    }
    return s.data[i % this.captureSamples];
  }

  /** Average of `count` samples starting at buffer index `start`; NaN if unavailable. */
  resample(s: Stream, start: number, count: number): number {
    if (
      !s.data || !this.captureSamples // not prepared
      || start + count > this.capture_i // not yet collected
      || (this.capture_i > this.captureSamples && start <= this.capture_i - this.captureSamples) // overwritten
    ) {
      return NaN;
    }
    let total = 0;
    for (let i = 0; i < count; i++) {
      total += s.data[(start + i) % this.captureSamples];
    }
    return total / count;
  }

  /** Returns the lowest buffer index currently available */
  bufferMin(): number {
    if (this.capture_i < this.captureSamples) return 0;
    return this.capture_i - this.captureSamples;
  }

  /** Returns the highest buffer index currently available */
  bufferMax(): number {
    return this.capture_i;
  }

  protected sampleDone(): void {
    this.capture_i++;
  }

  protected packetDone(): void {
    this.data.notify(this);

    if (!this.captureContinuous && this.capture_i >= this.captureSamples) {
      void this.doneCapture();
    }
  }

  protected notifyConfig(): void {
    this.configChanged.notify(this);
  }

  protected notifyOutputChanged(channel: Channel, source: OutputSource): void {
    this.outputChanged.notify(channel, source);
  }

  protected notifyGainChanged(channel: Channel, stream: Stream, _gain: number): void {
    this.gainChanged.notify(channel, stream, stream.getGain());
  }

  /** Called by the session when the USB device is unplugged */
  onDisconnect(): void {
    this.captureState = false;
    this.disconnected.notify();
  }

  /** Release the USB device */
  abstract close(): Promise<void>;

  protected abstract onResetCapture(): Promise<void>;
  protected abstract onStartCapture(): Promise<void>;
  protected abstract onPauseCapture(): Promise<void>;
}
