/**
 * CEE (Nonolith Connected Electrical Engineering) device driver.
 *
 * Port of connect/cee/cee.{hpp,cpp} to WebUSB. Vendor protocol:
 *   control 0xC0/0x00 wIndex 0|1|2|0xff  hw/fw/git version, version info
 *   control 0x40/0x80                    configure capture (per, devmode)
 *   control 0x40/0x65                    set gain (gainval, streamval)
 *   control 0xC0/0x15                    set current limit DACs
 *   control 0xC0/0xE0, 0x40/0xE1         read/write calibration EEPROM
 *   control 0xC0/0x20|0x21               GPIO get/set
 *   bulk IN 0x81 / OUT 0x02              sample streaming
 */

import { Channel, Stream, StreamingDevice } from './streaming-device';
import { makeConstantSource, OutputSource } from './output-source';
import { InPump, OutPump, UsbTransport } from './usb';

const EP_BULK_IN = 1;
const EP_BULK_OUT = 2;

const CMD_CONFIG_CAPTURE = 0x80;
const CMD_CONFIG_GAIN = 0x65;
const CMD_ISET_DAC = 0x15;
const DEVMODE_OFF = 0;
const DEVMODE_2SMU = 1;

const CEE_TIMER_CLOCK = 4e6; // 4 MHz
const CEE_DEFAULT_SAMPLE_TIME = 1 / 10000.0;
const CEE_CURRENT_GAIN_SCALE = 100000;
const CEE_DEFAULT_CURRENT_GAIN = Math.round(45 * 0.07 * CEE_CURRENT_GAIN_SCALE);

const V_MIN = 0;
const V_MAX = 5.0;
const DEFAULT_CURRENT_LIMIT = 200;

// Buffering target; the browser event loop has more jitter than the
// dedicated libusb thread, so use the conservative value from the
// Windows build of Connect.
const BUFFER_TIME = 0.05;

const IN_SAMPLES_PER_PACKET = 10;
const IN_PACKET_SIZE = 4 + IN_SAMPLES_PER_PACKET * 6; // 64
const OUT_SAMPLES_PER_PACKET = 10;
const OUT_PACKET_SIZE = 2 + OUT_SAMPLES_PER_PACKET * 3; // 32
const FLAG_PACKET_DROPPED = 1 << 0;

const N_TRANSFERS = 4;

const EEPROM_VALID_MAGIC = 0x90e26cee;
const EEPROM_FLAG_USB_POWER = 1 << 0;
const EEPROM_CAL_SIZE = 25;

export enum CEEChanMode {
  DISABLED = 0,
  SVMI = 1,
  SIMV = 2,
}

export interface CEECalibration {
  magic: number;
  offset_a_v: number;
  offset_a_i: number;
  offset_b_v: number;
  offset_b_i: number;
  dac200_a: number;
  dac200_b: number;
  dac400_a: number;
  dac400_b: number;
  current_gain_a: number;
  current_gain_b: number;
  flags: number;
}

function sign12(v: number): number {
  return (v << 20) >> 20;
}

function constrain(val: number, lo: number, hi: number): number {
  return val > hi ? hi : val < lo ? lo : val;
}

function decodeCal(d: DataView): CEECalibration {
  return {
    magic: d.getUint32(0, true),
    offset_a_v: d.getInt8(4),
    offset_a_i: d.getInt8(5),
    offset_b_v: d.getInt8(6),
    offset_b_i: d.getInt8(7),
    dac200_a: d.getInt16(8, true),
    dac200_b: d.getInt16(10, true),
    dac400_a: d.getInt16(12, true),
    dac400_b: d.getInt16(14, true),
    current_gain_a: d.getUint32(16, true),
    current_gain_b: d.getUint32(20, true),
    flags: d.getUint8(24),
  };
}

function encodeCal(cal: CEECalibration): Uint8Array<ArrayBuffer> {
  const buf = new Uint8Array(EEPROM_CAL_SIZE);
  const d = new DataView(buf.buffer);
  d.setUint32(0, cal.magic, true);
  d.setInt8(4, cal.offset_a_v);
  d.setInt8(5, cal.offset_a_i);
  d.setInt8(6, cal.offset_b_v);
  d.setInt8(7, cal.offset_b_i);
  d.setInt16(8, cal.dac200_a, true);
  d.setInt16(10, cal.dac200_b, true);
  d.setInt16(12, cal.dac400_a, true);
  d.setInt16(14, cal.dac400_b, true);
  d.setUint32(16, cal.current_gain_a, true);
  d.setUint32(20, cal.current_gain_b, true);
  d.setUint8(24, cal.flags);
  return buf;
}

export class CEEDevice extends StreamingDevice {
  readonly channelA = new Channel('a', 'A');
  readonly channelB = new Channel('b', 'B');

  //                            id   name         unit  min    max   omode uncert.     gain
  readonly channelAV = new Stream('v', 'Voltage A', 'V', V_MIN, V_MAX, 1, V_MAX / 2048, 1);
  readonly channelAI = new Stream('i', 'Current A', 'mA', 0, 0, 2, 1, 2);
  readonly channelBV = new Stream('v', 'Voltage B', 'V', V_MIN, V_MAX, 1, V_MAX / 2048, 1);
  readonly channelBI = new Stream('i', 'Current B', 'mA', 0, 0, 2, 1, 2);

  cal: CEECalibration = {
    magic: 0,
    offset_a_v: 0, offset_a_i: 0, offset_b_v: 0, offset_b_i: 0,
    dac200_a: 0x6b7, dac200_b: 0x6b7, dac400_a: 0x6b7, dac400_b: 0x6b7,
    current_gain_a: CEE_DEFAULT_CURRENT_GAIN, current_gain_b: CEE_DEFAULT_CURRENT_GAIN,
    flags: 0xff,
  };

  private _hwversion = '';
  private _fwversion = '';
  private _gitversion = '';

  private minPer = 100;
  private xmegaPer = 0;
  private packetsPerTransfer = 1;
  private firstPacket = true;

  private inPump: InPump | null = null;
  private outPump: OutPump | null = null;

  private constructor(public readonly usb: UsbTransport) {
    super(CEE_DEFAULT_SAMPLE_TIME);
  }

  get model(): string {
    return 'com.nonolithlabs.cee';
  }

  get hwVersion(): string {
    return this._hwversion;
  }

  get fwVersion(): string {
    return this._gitversion ? `${this._fwversion}/${this._gitversion}` : this._fwversion;
  }

  get serial(): string {
    return this.usb.serial;
  }

  static async open(device: USBDevice): Promise<CEEDevice> {
    const usb = new UsbTransport(device);
    await usb.open();
    const dev = new CEEDevice(usb);
    await dev.init();
    return dev;
  }

  private async init(): Promise<void> {
    this._hwversion = await this.usb.controlInString(0xc0, 0x00, 0, 0);
    this._fwversion = await this.usb.controlInString(0xc0, 0x00, 0, 1);

    if (this._fwversion >= '1.2') {
      const info = await this.usb.controlIn(0xc0, 0x00, 0, 0xff, 5);
      this._gitversion = await this.usb.controlInString(0xc0, 0x00, 0, 2);

      const perNs = info.getUint8(3);
      this.minPer = info.getUint8(4);
      if (perNs !== 250) {
        console.error(`CEE: alternate timer clock ${perNs} is not supported`);
      }
    } else {
      this.minPer = 100;
    }

    this.minSampleTime = this.minPer / CEE_TIMER_CLOCK;

    // Reset the state
    await this.usb.controlOut(0x40, CMD_CONFIG_CAPTURE, 0, DEVMODE_OFF);

    // Reset the gains
    await this.usb.controlOut(0x40, CMD_CONFIG_GAIN, 0x01 << 2, 0);
    await this.usb.controlOut(0x40, CMD_CONFIG_GAIN, 0x00 << 2, 1);
    await this.usb.controlOut(0x40, CMD_CONFIG_GAIN, 0x00 << 2, 2);
    await this.usb.controlOut(0x40, CMD_CONFIG_GAIN, 0x01 << 2, 3);

    await this.readCalibration();

    await this.configure(0, CEE_DEFAULT_SAMPLE_TIME, Math.ceil(12.0 / CEE_DEFAULT_SAMPLE_TIME), true, false);
  }

  async close(): Promise<void> {
    await this.pauseCapture();
    await this.usb.close();
  }

  // --- Calibration ---

  async readCalibration(): Promise<CEECalibration> {
    let valid = false;
    try {
      const d = await this.usb.controlIn(0xc0, 0xe0, 0, 0, 64);
      if (d.byteLength >= EEPROM_CAL_SIZE && d.getUint32(0, true) === EEPROM_VALID_MAGIC) {
        this.cal = decodeCal(d);
        valid = true;
      }
    } catch {
      // fall through to defaults
    }

    if (!valid) {
      console.error('CEE: reading calibration data failed, using defaults');
      this.cal = {
        magic: 0,
        offset_a_v: 0, offset_a_i: 0, offset_b_v: 0, offset_b_i: 0,
        dac200_a: 0x6b7, dac200_b: 0x6b7, dac400_a: 0x6b7, dac400_b: 0x6b7,
        current_gain_a: 0xffffffff, current_gain_b: 0xffffffff,
        flags: 0xff,
      };
    }

    await this.setCurrentLimit(this.cal.flags & EEPROM_FLAG_USB_POWER ? DEFAULT_CURRENT_LIMIT : 2000);

    if (this.cal.current_gain_a === 0xffffffff) {
      this.cal.current_gain_a = CEE_DEFAULT_CURRENT_GAIN;
    }
    if (this.cal.current_gain_b === 0xffffffff) {
      this.cal.current_gain_b = CEE_DEFAULT_CURRENT_GAIN;
    }

    return this.cal;
  }

  async writeCalibration(cal: CEECalibration): Promise<void> {
    cal.magic = EEPROM_VALID_MAGIC;
    this.cal = cal;
    await this.usb.controlOut(0x40, 0xe1, 0, 0, encodeCal(cal));
  }

  /** Apply measurement offsets without writing the EEPROM */
  tempCalibration(offsets: Partial<Pick<CEECalibration, 'offset_a_v' | 'offset_a_i' | 'offset_b_v' | 'offset_b_i'>>): void {
    Object.assign(this.cal, offsets);
  }

  // --- GPIO ---

  async gpio(set: boolean, dir = 0, out = 0): Promise<{ in: number; dir: number; out: number }> {
    const d = await this.usb.controlIn(0xc0, set ? 0x21 : 0x20, out, dir, 4);
    return { in: d.getUint8(0), dir: d.getUint8(1), out: d.getUint8(2) };
  }

  async enterBootloader(): Promise<void> {
    await this.usb.controlIn(0xc0, 0xbb, 0, 0, 100).catch(() => {
      // the device re-enumerates without completing the transfer
    });
  }

  // --- Configuration ---

  async configure(mode: number, sampleTime: number, samples: number, continuous: boolean, raw: boolean): Promise<void> {
    await this.pauseCapture();

    // Clean up previous configuration
    this.channelA.source = null;
    this.channelB.source = null;
    this.channels = [];
    this.channelA.streams = [];
    this.channelB.streams = [];

    // Store state
    this.xmegaPer = Math.round(sampleTime * CEE_TIMER_CLOCK);
    if (this.xmegaPer < this.minPer) this.xmegaPer = this.minPer;
    this.sampleTime = this.xmegaPer / CEE_TIMER_CLOCK; // convert back to get the actual sample time

    this.captureSamples = samples;
    this.captureContinuous = continuous;
    this.devMode = mode;
    this.rawMode = raw;
    this.captureLength = this.captureSamples * this.sampleTime;

    this.packetsPerTransfer = Math.ceil(BUFFER_TIME / (this.sampleTime * IN_SAMPLES_PER_PACKET) / N_TRANSFERS);

    this.capture_i = this.capture_o = 0;

    if (this.devMode === 0) {
      this.channels.push(this.channelA);
      this.channelA.source = makeConstantSource(0, 0);
      this.channelA.streams.push(this.channelAV, this.channelAI);

      this.channels.push(this.channelB);
      this.channelB.source = makeConstantSource(0, 0);
      this.channelB.streams.push(this.channelBV, this.channelBI);

      if (this.rawMode) {
        this.channelAV.units = this.channelBV.units = 'LSB';
        this.channelAI.units = this.channelBI.units = 'LSB';

        this.channelAV.min = this.channelBV.min = -100;
        this.channelAV.max = this.channelBV.max = 2047;
        this.channelAI.min = this.channelBI.min = -2048;
        this.channelAI.max = this.channelBI.max = 2047;
      } else {
        this.channelAV.units = this.channelBV.units = 'V';
        this.channelAI.units = this.channelBI.units = 'mA';

        let effectiveLimitA = 2.5 / (this.cal.current_gain_a / CEE_CURRENT_GAIN_SCALE) / this.channelAI.normalGain * 1000;
        if (effectiveLimitA > this.currentLimit) effectiveLimitA = this.currentLimit;

        let effectiveLimitB = 2.5 / (this.cal.current_gain_b / CEE_CURRENT_GAIN_SCALE) / this.channelBI.normalGain * 1000;
        if (effectiveLimitB > this.currentLimit) effectiveLimitB = this.currentLimit;

        this.channelAV.min = this.channelBV.min = V_MIN;
        this.channelAV.max = this.channelBV.max = V_MAX;
        this.channelAI.min = -effectiveLimitA;
        this.channelBI.min = -effectiveLimitB;
        this.channelAI.max = effectiveLimitA;
        this.channelBI.max = effectiveLimitB;
      }

      this.channelAV.allocate(this.captureSamples);
      this.channelAI.allocate(this.captureSamples);
      this.channelBV.allocate(this.captureSamples);
      this.channelBI.allocate(this.captureSamples);
    }

    this.notifyConfig();
  }

  override async setCurrentLimit(mode: number): Promise<void> {
    let a: number, b: number;

    if (mode === 200) {
      a = this.cal.dac200_a;
      b = this.cal.dac200_b;
    } else if (mode === 400) {
      a = this.cal.dac400_a;
      b = this.cal.dac400_b;
    } else if (mode === 2000) {
      a = b = 0;
    } else {
      console.error(`CEE: invalid current limit ${mode}`);
      return;
    }

    await this.usb.controlIn(0xc0, CMD_ISET_DAC, a, b, 0).catch(() => undefined);
    this.currentLimit = mode;
  }

  // --- Capture control ---

  protected async onResetCapture(): Promise<void> {
    if (this.channelA.source) this.channelA.source.startSample = 0;
    if (this.channelB.source) this.channelB.source.startSample = 0;
  }

  protected async onStartCapture(): Promise<void> {
    // Turn on the device
    await this.usb.controlOut(0x40, CMD_CONFIG_CAPTURE, this.xmegaPer, DEVMODE_2SMU);

    // Ignore the effect of output samples we sent before pausing
    this.capture_o = this.capture_i;

    this.firstPacket = true;

    this.inPump = new InPump(
      this.usb, EP_BULK_IN,
      IN_PACKET_SIZE * this.packetsPerTransfer, N_TRANSFERS,
      (d) => this.handleInTransfer(d),
      (e) => this.onStreamError(e),
    );
    this.outPump = new OutPump(
      this.usb, EP_BULK_OUT,
      OUT_PACKET_SIZE * this.packetsPerTransfer, N_TRANSFERS,
      (buf) => this.fillOutTransfer(buf),
      (e) => this.onStreamError(e),
    );
    this.inPump.start();
    this.outPump.start();
  }

  protected async onPauseCapture(): Promise<void> {
    const inPump = this.inPump;
    const outPump = this.outPump;
    this.inPump = null;
    this.outPump = null;

    const stopping = Promise.allSettled([inPump?.stop(), outPump?.stop()]);

    await this.usb.controlOut(0x40, CMD_CONFIG_CAPTURE, 0, DEVMODE_OFF);
    await this.usb.abortTransfers();
    await stopping;

    this.capture_o = this.capture_i;
  }

  private onStreamError(e: Error): void {
    console.error('CEE stream error:', e);
    this.error.notify(e);
    void this.pauseCapture();
  }

  // --- Gain ---

  protected override async setInternalGain(channel: Channel, stream: Stream, gain: number): Promise<void> {
    let streamval: number;
    if (stream === this.channelAI) streamval = 0;
    else if (stream === this.channelAV) streamval = 1;
    else if (stream === this.channelBV) streamval = 2;
    else if (stream === this.channelBI) streamval = 3;
    else return;

    const gainvals: Record<number, number> = { 1: 0, 2: 1, 4: 2, 8: 3, 16: 4, 32: 5, 64: 6 };
    const g = gainvals[gain];
    if (g === undefined) return;
    const gainval = g << 2;

    stream.gain = gain;

    const wasCapturing = this.captureState;
    if (wasCapturing) {
      await this.onPauseCapture();
    }

    await this.usb.controlOut(0x40, CMD_CONFIG_GAIN, gainval, streamval);

    if (wasCapturing) {
      await this.onStartCapture();
    }

    this.notifyGainChanged(channel, stream, gain);
  }

  // --- Streaming data path ---

  private handleInTransfer(data: DataView): void {
    let vFactor = 5.0 / 2048.0;
    let iFactorA = 2.5 / 2048.0 / (this.cal.current_gain_a / CEE_CURRENT_GAIN_SCALE) * 1000.0;
    let iFactorB = 2.5 / 2048.0 / (this.cal.current_gain_b / CEE_CURRENT_GAIN_SCALE) * 1000.0;
    if (this.rawMode) vFactor = iFactorA = iFactorB = 1;

    const npackets = Math.floor(data.byteLength / IN_PACKET_SIZE);

    for (let p = 0; p < npackets; p++) {
      const base = p * IN_PACKET_SIZE;
      const modeA = data.getUint8(base + 0);
      const modeB = data.getUint8(base + 1);
      const flags = data.getUint8(base + 2);

      if (flags & FLAG_PACKET_DROPPED && !this.firstPacket) {
        console.error('CEE: dropped packet');
        this.packetDrop.notify();
      }

      this.firstPacket = false;

      for (let i = 0; i < IN_SAMPLES_PER_PACKET; i++) {
        const s = base + 4 + i * 6;
        const avl = data.getUint8(s + 0);
        const ail = data.getUint8(s + 1);
        const aihAvh = data.getUint8(s + 2);
        const bvl = data.getUint8(s + 3);
        const bil = data.getUint8(s + 4);
        const bihBvh = data.getUint8(s + 5);

        const av = sign12(((aihAvh & 0x0f) << 8) | avl);
        const ai = sign12(((aihAvh & 0xf0) << 4) | ail);
        const bv = sign12(((bihBvh & 0x0f) << 8) | bvl);
        const bi = sign12(((bihBvh & 0xf0) << 4) | bil);

        this.put(this.channelAV, (this.cal.offset_a_v + av) * vFactor / this.channelAV.gain);
        if ((modeA & 0x3) !== CEEChanMode.DISABLED) {
          this.put(this.channelAI, (this.cal.offset_a_i + ai) * iFactorA / this.channelAI.gain);
        } else {
          this.put(this.channelAI, 0);
        }
        this.put(this.channelBV, (this.cal.offset_b_v + bv) * vFactor / this.channelBV.gain);
        if ((modeB & 0x3) !== CEEChanMode.DISABLED) {
          this.put(this.channelBI, (this.cal.offset_b_i + bi) * iFactorB / this.channelBI.gain);
        } else {
          this.put(this.channelBI, 0);
        }
        this.sampleDone();
      }
    }

    this.packetDone();
    this.checkOutputEffective(this.channelA);
    this.checkOutputEffective(this.channelB);
  }

  override async setOutput(channel: Channel, source: OutputSource): Promise<void> {
    source.initialize(this.capture_o, channel.source);
    channel.source = source;
    channel.source.startSample = this.capture_o + 1;
    this.notifyOutputChanged(channel, source);
  }

  private checkOutputEffective(channel: Channel): void {
    if (!channel.source) return;
    if (!channel.source.effective && this.capture_i > channel.source.startSample) {
      channel.source.effective = true;
      this.notifyOutputChanged(channel, channel.source);
    }
  }

  private encodeOut(mode: number, val: number, igain: number): number {
    if (this.rawMode) {
      return constrain(val, 0, 4095);
    }
    let v = 0;
    if (mode === CEEChanMode.SVMI) {
      val = constrain(val, V_MIN, V_MAX);
      v = 4095 * val / 5.0;
    } else if (mode === CEEChanMode.SIMV) {
      val = constrain(val, -this.currentLimit, this.currentLimit);
      v = 4095 * (1.25 + (igain / CEE_CURRENT_GAIN_SCALE) * val / 1000.0) / 2.5;
    }
    return constrain(Math.round(v), 0, 4095);
  }

  private fillOutTransfer(buf: Uint8Array): void {
    const srcA = this.channelA.source;
    const srcB = this.channelB.source;

    if (srcA && srcB) {
      const modeA = srcA.mode;
      const modeB = srcB.mode;

      for (let p = 0; p < this.packetsPerTransfer; p++) {
        const base = p * OUT_PACKET_SIZE;
        buf[base + 0] = modeA;
        buf[base + 1] = modeB;

        for (let i = 0; i < OUT_SAMPLES_PER_PACKET; i++) {
          const a = this.encodeOut(modeA, srcA.getValue(this.capture_o, this.sampleTime), this.cal.current_gain_a);
          const b = this.encodeOut(modeB, srcB.getValue(this.capture_o, this.sampleTime), this.cal.current_gain_b);
          const s = base + 2 + i * 3;
          buf[s + 0] = a & 0xff;
          buf[s + 1] = b & 0xff;
          buf[s + 2] = ((b >> 4) & 0xf0) | (a >> 8);
          this.capture_o++;
        }
      }
    } else {
      buf.fill(0);
    }
  }
}
