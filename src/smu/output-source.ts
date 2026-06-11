/**
 * Output signal sources.
 *
 * Port of connect/streaming_device/output_source.cpp. A source generates
 * the output waveform sample-by-sample as the OUT bulk pipe is filled.
 */

export interface ArbWavePoint {
  /** Sample time, relative to waveform start */
  t: number;
  v: number;
}

/** Plain-object description of a source, suitable for UI state and serialization. */
export interface OutputSourceDescription {
  mode: number;
  startSample: number;
  effective: boolean;
  source: string;
  hint: string;
  [key: string]: unknown;
}

export abstract class OutputSource {
  /** The output sample number at which this source was added */
  startSample = 0;

  /** true if this source's effect has come back as input */
  effective = false;

  /** hint passed by the client, not used but repeated back */
  hint = '';

  protected constructor(public readonly mode: number) {}

  abstract displayName(): string;

  abstract getValue(sample: number, sampleTime: number): number;

  describe(): OutputSourceDescription {
    return {
      mode: this.mode,
      startSample: this.startSample,
      effective: this.effective,
      source: this.displayName(),
      hint: this.hint,
    };
  }

  initialize(_sample: number, _prevSrc: OutputSource | null): void {}

  getPhaseZeroAfterSample(_sample: number): number {
    return Infinity;
  }
}

export class ConstantSource extends OutputSource {
  constructor(mode: number, public value: number) {
    super(mode);
  }

  displayName(): string {
    return 'constant';
  }

  getValue(_sample: number, _sampleTime: number): number {
    return this.value;
  }

  override describe(): OutputSourceDescription {
    return { ...super.describe(), value: this.value };
  }

  override getPhaseZeroAfterSample(sample: number): number {
    return sample;
  }
}

export class AdvSquareWaveSource extends OutputSource {
  constructor(
    mode: number,
    public high: number,
    public low: number,
    public highSamples: number,
    public lowSamples: number,
    public phase: number,
    public relPhase: boolean,
  ) {
    super(mode);
    if (highSamples + lowSamples === 0) {
      throw new Error('Square wave must have nonzero period.');
    }
  }

  displayName(): string {
    return 'adv_square';
  }

  getValue(sample: number, _sampleTime: number): number {
    const per = this.highSamples + this.lowSamples;
    const s = (((sample + this.phase) % per) + per) % per;
    return s < this.lowSamples ? this.low : this.high;
  }

  override describe(): OutputSourceDescription {
    return {
      ...super.describe(),
      high: this.high,
      low: this.low,
      highSamples: this.highSamples,
      lowSamples: this.lowSamples,
    };
  }

  override getPhaseZeroAfterSample(sample: number): number {
    const per = this.highSamples + this.lowSamples;
    return sample + (per + this.lowSamples - ((sample + this.phase) % per)) % per;
  }

  override initialize(sample: number, prevSrc: OutputSource | null): void {
    if (prevSrc instanceof AdvSquareWaveSource && this.relPhase) {
      const period = this.highSamples + this.lowSamples;
      const oldPeriod = prevSrc.highSamples + prevSrc.lowSamples;
      this.phase +=
        Math.round(((sample + prevSrc.phase) % oldPeriod) / oldPeriod * period) - (sample % period);
    }
    this.phase = this.phase % (this.highSamples + this.lowSamples);
  }
}

export abstract class PeriodicSource extends OutputSource {
  constructor(
    mode: number,
    public offset: number,
    public amplitude: number,
    public period: number,
    public phase = 0,
    public relativePhase = false,
  ) {
    super(mode);
  }

  override describe(): OutputSourceDescription {
    return {
      ...super.describe(),
      offset: this.offset,
      amplitude: this.amplitude,
      period: this.period,
      phase: this.phase,
    };
  }

  override initialize(sample: number, prevSrc: OutputSource | null): void {
    if (prevSrc instanceof PeriodicSource && this.relativePhase) {
      this.phase += ((sample + prevSrc.phase) % prevSrc.period) / prevSrc.period * this.period - sample;
    }
    this.phase = this.phase % this.period;
  }

  override getPhaseZeroAfterSample(sample: number): number {
    return sample + (this.period - ((sample + this.phase) % this.period)) % this.period;
  }
}

export class SineWaveSource extends PeriodicSource {
  displayName(): string {
    return 'sine';
  }

  getValue(sample: number, _sampleTime: number): number {
    return Math.sin((sample + this.phase) * 2 * Math.PI / this.period) * this.amplitude + this.offset;
  }
}

export class TriangleWaveSource extends PeriodicSource {
  displayName(): string {
    return 'triangle';
  }

  getValue(sample: number, _sampleTime: number): number {
    const { phase, period, amplitude, offset } = this;
    const m = (x: number, y: number) => ((x % y) + y) % y;
    return (Math.abs(m(sample + phase - period / 4, period) / period * 2 - 1) * 2 - 1) * amplitude + offset;
  }
}

export class SquareWaveSource extends PeriodicSource {
  displayName(): string {
    return 'square';
  }

  getValue(sample: number, _sampleTime: number): number {
    const s = (((sample + this.phase) % this.period) + this.period) % this.period;
    return s < this.period / 2 ? this.offset + this.amplitude : this.offset - this.amplitude;
  }

  override getPhaseZeroAfterSample(sample: number): number {
    // its own definition because it jumps instead of slides
    const s = (((sample + this.phase) % this.period) + this.period) % this.period;
    return sample + Math.ceil(this.period - s);
  }
}

export class ArbitraryWaveformSource extends OutputSource {
  startTime = 0;
  private index = 0;

  constructor(
    mode: number,
    public phase: number,
    public values: ArbWavePoint[],
    public repeatCount: number,
  ) {
    super(mode);
    if (this.repeatCount === 0) this.repeatCount = 1;

    if (values.length < 1) throw new Error('Arb wave must have at least one point.');
    if (values[0].t !== 0) throw new Error('Arb wave first point must have t=0.');

    let lastT = 0;
    for (const point of values) {
      if (point.t < lastT) throw new Error('Arb wave points must be in time order.');
      lastT = point.t;
    }

    if (this.period() === 0 && this.repeatCount !== 1) {
      throw new Error('Arb wave with repeat must have nonzero period.');
    }
  }

  displayName(): string {
    return 'arb';
  }

  period(): number {
    return this.values[this.values.length - 1].t;
  }

  getValue(sample: number, _sampleTime: number): number {
    const length = this.values.length;

    if (sample < this.startTime) {
      sample = 0;
    } else {
      // All times are relative to startTime
      sample -= this.startTime;
    }

    let time1: number, time2: number;
    let value1: number, value2: number;

    for (;;) {
      time1 = this.values[this.index].t;
      value1 = this.values[this.index].v;

      const nextIndex = this.index + 1;

      if (nextIndex >= length) {
        // repeat === -1 means infinite
        if (this.repeatCount > 1 || this.repeatCount === -1) {
          if (this.repeatCount > 0) this.repeatCount--;
          this.index = 0;
          this.startTime += time1;
          sample -= time1;
          continue;
        } else {
          // If repeat is disabled, the last value remains forever
          return value1;
        }
      }

      time2 = this.values[nextIndex].t;
      value2 = this.values[nextIndex].v;

      if (sample >= time2) {
        // When we pass the next point, move forward in the list
        this.index = nextIndex;
        continue;
      } else {
        break;
      }
    }

    // For the first point
    if (sample < time1) return value1;

    // Proportion of the time between the last point and the next point
    const p = (sample - time1) / (time2 - time1);

    // Trapezoidal interpolation
    return (1 - p) * value1 + p * value2;
  }

  override describe(): OutputSourceDescription {
    return {
      ...super.describe(),
      phase: this.phase,
      repeat: this.repeatCount,
      values: this.values.map((p) => ({ t: p.t, v: p.v })),
      period: this.period(),
    };
  }

  override initialize(sample: number, _prevSrc: OutputSource | null): void {
    if (this.phase < 0) {
      this.startTime = sample;
      this.phase = sample;
    } else if (this.repeatCount !== 1) {
      const per = this.period();
      this.startTime = sample - (sample % per) + (this.phase % per);
    } else {
      this.startTime = this.phase;
    }
  }

  override getPhaseZeroAfterSample(sample: number): number {
    const per = this.period();
    if (per === 0) return sample;
    return sample + (per - ((sample - this.phase) % per)) % per;
  }
}

/** Parameters accepted by makeSource(), matching the Connect WS `set` command. */
export interface SourceDescription {
  source?: string;
  mode?: number;
  hint?: string;
  value?: number;
  high?: number;
  low?: number;
  highSamples?: number;
  lowSamples?: number;
  offset?: number;
  amplitude?: number;
  period?: number;
  phase?: number;
  relPhase?: boolean;
  repeat?: number;
  values?: ArbWavePoint[];
}

export function makeConstantSource(mode: number, value: number): ConstantSource {
  return new ConstantSource(mode, value);
}

export function makePeriodicSource(
  mode: number, source: string, offset: number, amplitude: number,
  period: number, phase: number, relPhase: boolean,
): PeriodicSource {
  switch (source) {
    case 'sine':
      return new SineWaveSource(mode, offset, amplitude, period, phase, relPhase);
    case 'triangle':
      return new TriangleWaveSource(mode, offset, amplitude, period, phase, relPhase);
    case 'square':
      return new SquareWaveSource(mode, offset, amplitude, period, phase, relPhase);
    default:
      throw new Error(`Invalid source: ${source}`);
  }
}

export function makeSource(n: SourceDescription): OutputSource {
  const source = n.source ?? 'constant';
  const mode = n.mode ?? 0;

  let r: OutputSource;

  if (source === 'constant') {
    r = makeConstantSource(mode, n.value ?? 0);
  } else if (source === 'adv_square') {
    if (n.high == null || n.low == null || n.highSamples == null || n.lowSamples == null) {
      throw new Error('adv_square requires high, low, highSamples, lowSamples');
    }
    r = new AdvSquareWaveSource(mode, n.high, n.low, n.highSamples, n.lowSamples, n.phase ?? 0, n.relPhase ?? true);
  } else if (source === 'sine' || source === 'triangle' || source === 'square') {
    if (n.offset == null || n.amplitude == null || n.period == null) {
      throw new Error(`${source} requires offset, amplitude, period`);
    }
    r = makePeriodicSource(mode, source, n.offset, n.amplitude, n.period, n.phase ?? 0, n.relPhase ?? true);
  } else if (source === 'arb') {
    if (!n.values) throw new Error('arb requires values');
    r = new ArbitraryWaveformSource(mode, n.phase ?? -1, n.values, n.repeat ?? 0);
  } else {
    throw new Error(`Invalid source: ${source}`);
  }

  r.hint = n.hint ?? '';
  return r;
}
