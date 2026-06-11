/**
 * Stream listeners: decimated, optionally triggered data delivery.
 *
 * Port of connect/streaming_device/stream_listener.{hpp,cpp}. A listener
 * walks a StreamingDevice's ring buffers and produces chunked updates of
 * boxcar-decimated samples, optionally gated on a level-crossing trigger
 * (INSTREAM) or the phase of an output source (OUTSOURCE), with repeating
 * sweeps, forced trigger timeout, and subsample trigger error.
 *
 * Call poll() whenever the device fires its `data` event. Each update has
 * the same shape Connect sent over the wire, so existing clients of the
 * WS protocol's `update` action map directly.
 */

import { Channel, Stream, StreamingDevice } from './streaming-device';

export enum TriggerType {
  NONE = 0,
  /** Trigger on a level crossing of an input stream */
  INSTREAM,
  /** Trigger relative to the phase of an output source */
  OUTSOURCE,
}

export interface InStreamTriggerConfig {
  type: 'in';
  stream: Stream;
  level: number;
  holdoff?: number;
  offset?: number;
  force?: number;
  repeat?: boolean;
}

export interface OutSourceTriggerConfig {
  type: 'out';
  channel: Channel;
  holdoff?: number;
  offset?: number;
  force?: number;
  repeat?: boolean;
}

export type TriggerConfig = InStreamTriggerConfig | OutSourceTriggerConfig;

export interface StreamListenerConfig {
  streams: Stream[];
  decimateFactor?: number;
  /** Starting device sample index; negative values are relative to the latest sample */
  start?: number;
  /** Number of output samples to produce; <= 0 for unlimited */
  count?: number;
  trigger?: TriggerConfig | null;
}

export interface StreamUpdate {
  /** Output sample index of the first sample in this update */
  idx: number;
  /** Device sample index (valid when idx === 0) */
  sampleIndex: number;
  /** Trigger subsample error in device samples; undefined unless triggered at idx 0 */
  subsample: number | undefined;
  /** One Float32Array of decimated samples per requested stream */
  data: Float32Array[];
  /** True when this update completes a non-repeating capture */
  done: boolean;
  /** True if the trigger timed out and was forced */
  triggerForced: boolean;
}

export class StreamListener {
  streams: Stream[];
  decimateFactor: number;

  /** device sample index of the next input sample */
  index: number;
  /** output (decimated) sample index */
  outIndex = 0;
  count: number;

  triggerType = TriggerType.NONE;
  triggered = false;
  // false when no trigger is configured, so count-limited listeners finish
  triggerRepeat = false;
  triggerChannel: Channel | null = null;
  triggerLevel = 0;
  triggerStream: Stream | null = null;
  triggerHoldoff = 0;
  triggerOffset = 0;
  triggerForce = 0;
  triggerForceIndex = 0;
  triggerSubsampleError = 0;

  constructor(public device: StreamingDevice, config: StreamListenerConfig) {
    this.streams = config.streams;
    this.decimateFactor = Math.max(1, Math.floor(config.decimateFactor ?? 1));

    let start = config.start ?? -1;
    if (start < 0) {
      // Negative indexes are relative to latest sample
      start = this.device.bufferMax() + start + 1;
    }
    this.index = start < 0 ? 0 : start;

    this.count = config.count ?? -1;

    const t = config.trigger;
    if (t) {
      if (t.type === 'in') {
        this.triggerType = TriggerType.INSTREAM;
        this.triggerLevel = t.level;
        this.triggerStream = t.stream;
      } else {
        this.triggerType = TriggerType.OUTSOURCE;
        this.triggerChannel = t.channel;
      }

      this.triggerRepeat = t.repeat ?? true;
      this.triggerHoldoff = t.holdoff ?? 0;
      this.triggerOffset = t.offset ?? 0;

      if (this.triggerOffset < 0 && -this.triggerOffset >= this.triggerHoldoff) {
        // Prevent big negative offsets that could cause infinite loops
        this.triggerHoldoff = -this.triggerOffset;
      }
      this.triggerForce = t.force ?? 0;
      this.triggerForceIndex = this.index + this.triggerForce;
    }
  }

  /** Restart from device sample 0 (capture was reset) */
  reset(): void {
    this.index = 0;
    this.outIndex = 0;
    this.triggered = false;
    this.triggerSubsampleError = 0;
    this.triggerForceIndex = this.triggerForce;
  }

  private howManySamples(): number {
    if (this.triggerType !== TriggerType.NONE && !this.triggered && !this.findTrigger()) {
      // Waiting for a trigger and haven't found it yet
      return 0;
    }

    if (this.index + this.decimateFactor >= this.device.capture_i) {
      // The data for our next output sample hasn't been collected yet
      return 0;
    }

    // Calculate the number of decimateFactor-sized chunks available
    let nchunks = Math.floor((this.device.capture_i - this.index) / this.decimateFactor);

    // But if it's more than the remaining number of output samples, clamp it
    if (this.count > 0 && this.count - this.outIndex < nchunks) {
      nchunks = this.count - this.outIndex;
    }

    return nchunks;
  }

  /**
   * Drain available samples into zero or more updates. Returns the updates
   * and whether the listener is finished (done non-repeating capture).
   */
  poll(): { updates: StreamUpdate[]; finished: boolean } {
    const updates: StreamUpdate[] = [];

    for (;;) {
      const nchunks = this.howManySamples();
      if (!nchunks) return { updates, finished: false };

      const willBeDone = this.count > 0 && this.outIndex + nchunks >= this.count;

      const data = this.streams.map((stream) => {
        const a = new Float32Array(nchunks);
        for (let chunk = 0; chunk < nchunks; chunk++) {
          a[chunk] = this.device.resample(stream, this.index + chunk * this.decimateFactor, this.decimateFactor);
        }
        return a;
      });

      const atStart = this.outIndex === 0;
      updates.push({
        idx: this.outIndex,
        sampleIndex: this.index,
        subsample: atStart && this.triggered ? this.triggerSubsampleError : undefined,
        data,
        done: willBeDone && !this.triggerRepeat,
        triggerForced: atStart && this.triggerForce > 0 && this.index > this.triggerForceIndex,
      });

      this.index += nchunks * this.decimateFactor;
      this.outIndex += nchunks;

      if (!willBeDone) return { updates, finished: false };

      if (this.triggerRepeat) {
        // Sweep complete; rearm and keep draining in case another full
        // sweep is already buffered
        this.outIndex = 0;
        this.triggered = false;
        this.index += this.triggerHoldoff;
        this.triggerForceIndex = this.index + this.triggerForce;
        continue;
      }

      return { updates, finished: true };
    }
  }

  /** Returns true if the trigger was found; advances index to the trigger point. */
  private findTrigger(): boolean {
    this.triggerSubsampleError = 0;

    if (this.triggerType === TriggerType.INSTREAM && this.triggerStream) {
      let state = this.device.get(this.triggerStream, this.index) > this.triggerLevel;
      while (++this.index < this.device.capture_i) {
        const newState = this.device.get(this.triggerStream, this.index) > this.triggerLevel;

        if (newState && !state) {
          this.index += this.triggerOffset;
          return (this.triggered = true);
        }
        state = newState;
      }

      if (this.triggerForce > 0 && this.index > this.triggerForceIndex) {
        return (this.triggered = true);
      }
    } else if (this.triggerType === TriggerType.OUTSOURCE && this.triggerChannel?.source) {
      const zero = this.triggerChannel.source.getPhaseZeroAfterSample(this.index);

      if (Number.isFinite(zero) && this.device.capture_o >= Math.round(zero)) {
        this.index = Math.round(zero) + this.triggerOffset;
        this.triggerSubsampleError = zero - Math.round(zero);
        return (this.triggered = true);
      } else if (this.triggerForce > 0 && this.device.capture_i >= this.triggerForceIndex) {
        this.index = this.triggerForceIndex;
        return (this.triggered = true);
      }
    }

    return false;
  }
}
