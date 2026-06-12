/**
 * M1K (ADALM1000) device driver.
 *
 * Port of connect/m1k/m1k.{hpp,cpp} to WebUSB. The vendor protocol follows
 * libsmu's device_m1000.cpp:
 *   control 0xC0/0x00 wIndex 0|1   hw/fw version strings
 *   control 0xC0/0x01              read calibration EEPROM
 *   control 0x40/0x02              write calibration EEPROM
 *   control 0x40/0x03              set LEDs
 *   control 0x40/0x05              set serial number
 *   control 0xC0/0x17              ADM1177 power monitor read
 *   control 0xC0/0x19              ADT temperature read
 *   control 0x40/0x50|0x51        GPIO clear/set pin
 *   control 0x40/0x53              set channel mode
 *   control 0x40/0x59              set feedback digipots
 *   control 0xC0/0x6F              read SOF frame number (sync)
 *   control 0x40/0xC5              start/stop sampling (per, sof_start)
 *   control 0x40/0xCC              init hardware
 *   bulk IN 0x81 / OUT 0x02        sample streaming (alt setting 1)
 */

import { Channel, Stream, StreamingDevice } from './streaming-device';
import { makeConstantSource, OutputSource } from './output-source';
import { InPump, OutPump, UsbTransport } from './usb';

const EP_BULK_IN = 1;
const EP_BULK_OUT = 2;

const M1K_BUFFER_TIME = 0.05;
const M1K_DEFAULT_SAMPLE_TIME = 1.0 / 100000.0; // 100 ksps

export const M1K_EEPROM_VALID = 0x01ee02dd;
const M1K_EEPROM_CAL_SIZE = 4 + 8 * 4 * 3; // 100 bytes

const M1K_CHUNK_SIZE = 256;
const M1K_IN_PACKET_SIZE = M1K_CHUNK_SIZE * 4 * 2; // 2048 bytes
const M1K_OUT_PACKET_SIZE = M1K_CHUNK_SIZE * 2 * 2; // 1024 bytes

const M1K_TIMER_CLOCK = 48e6;
const M1K_MIN_PER = 240; // 100 ksps
const M1K_MAX_PER = 24000; // ~1 ksps

const M1K_N_TRANSFERS = 2;

const M1K_V_RESOLUTION = 5.0 / 65536.0;
const M1K_I_RESOLUTION = 0.4 / 65536.0;
const M1K_V_MIN = 0.0;
const M1K_V_MAX = 5.0;
const M1K_I_MIN = -200.0; // mA
const M1K_I_MAX = 200.0; // mA

// GPIO pin definitions (PIOB offset = 0x20)
const PIN = {
  CHA_50R_2V5: 0x20 + 0, // PB0
  CHA_50R_GND: 0x20 + 1, // PB1
  CHA_FEEDBACK: 0x20 + 2, // PB2
  CHA_OUTPUT_EN: 0x20 + 3, // PB3
  CHB_50R_2V5: 0x20 + 5, // PB5
  CHB_50R_GND: 0x20 + 6, // PB6
  CHB_FEEDBACK: 0x20 + 7, // PB7
  CHB_OUTPUT_EN: 0x20 + 8, // PB8
  CHA_SPLIT: 34, // PA2
  CHB_SPLIT: 39, // PA7
} as const;

export enum M1KMode {
  HI_Z = 0,
  SVMI = 1,
  SIMV = 2,
  HI_Z_SPLIT = 3,
  SVMI_SPLIT = 4,
  SIMV_SPLIT = 5,
}

export const M1K_MODE_NAMES = ['hi_z', 'svmi', 'simv', 'hi_z_split', 'svmi_split', 'simv_split'] as const;

/**
 * EEPROM calibration. Index mapping:
 *   0: ChA measure voltage    1: ChA measure current
 *   2: ChA source voltage     3: ChA source current
 *   4: ChB measure voltage    5: ChB measure current
 *   6: ChB source voltage     7: ChB source current
 */
export interface M1KCalibration {
  valid: boolean;
  offset: number[];
  gain_p: number[];
  gain_n: number[];
}

/** Per-channel analog front-end state (tracked locally) */
export interface M1KFrontend {
  r50_2v5: boolean;
  r50_gnd: boolean;
  feedback: boolean;
  output_en: boolean;
  split: boolean;
  pot_r1: number;
  pot_r2: number;
}

export type M1KFrontendSwitch = 'r50_2v5' | 'r50_gnd' | 'feedback' | 'output_en' | 'split';

function constrain(val: number, lo: number, hi: number): number {
  return val > hi ? hi : val < lo ? lo : val;
}

function defaultCal(): M1KCalibration {
  return {
    valid: false,
    offset: new Array(8).fill(0),
    gain_p: new Array(8).fill(1),
    gain_n: new Array(8).fill(1),
  };
}

export class M1KDevice extends StreamingDevice {
  readonly channelA = new Channel('a', 'A');
  readonly channelB = new Channel('b', 'B');

  readonly channelAV = new Stream('v', 'Voltage A', 'V', M1K_V_MIN, M1K_V_MAX, 1, M1K_V_RESOLUTION, 1);
  readonly channelAI = new Stream('i', 'Current A', 'mA', M1K_I_MIN, M1K_I_MAX, 2, M1K_I_RESOLUTION * 1000.0, 1);
  readonly channelBV = new Stream('v', 'Voltage B', 'V', M1K_V_MIN, M1K_V_MAX, 1, M1K_V_RESOLUTION, 1);
  readonly channelBI = new Stream('i', 'Current B', 'mA', M1K_I_MIN, M1K_I_MAX, 2, M1K_I_RESOLUTION * 1000.0, 1);

  cal: M1KCalibration = defaultCal();

  readonly frontend: [M1KFrontend, M1KFrontend] = [
    // Init frontend state to match firmware defaults
    // (feedback is active LOW, initialized LOW = on)
    { r50_2v5: false, r50_gnd: false, feedback: true, output_en: false, split: false, pot_r1: 0, pot_r2: 0 },
    { r50_2v5: false, r50_gnd: false, feedback: true, output_en: false, split: false, pot_r1: 0, pot_r2: 0 },
  ];

  ledState = 0;

  private _hwversion = '';
  private _fwversion = '';
  private fwInterleaved = false;

  private mode: [number, number] = [M1KMode.HI_Z, M1KMode.HI_Z];

  // Output/input lead tracking for stream resync (see handleInTransfer)
  private leadBaseline: number | null = null;
  private leadMin = Infinity;
  private leadCount = 0;
  private leadSettle = 16;
  private m1kPer = 0;
  private packetsPerTransfer = 1;

  private inPump: InPump | null = null;
  private outPump: OutPump | null = null;

  private constructor(public readonly usb: UsbTransport) {
    super(M1K_DEFAULT_SAMPLE_TIME);
  }

  get model(): string {
    return 'com.analogdevices.m1k';
  }

  get hwVersion(): string {
    return this._hwversion;
  }

  get fwVersion(): string {
    return this._fwversion;
  }

  get serial(): string {
    return this.usb.serial;
  }

  get channelModes(): { a: string; b: string } {
    return { a: M1K_MODE_NAMES[this.mode[0]], b: M1K_MODE_NAMES[this.mode[1]] };
  }

  static async open(device: USBDevice): Promise<M1KDevice> {
    const usb = new UsbTransport(device);
    await usb.open();
    const dev = new M1KDevice(usb);
    await dev.init();
    return dev;
  }

  private async init(): Promise<void> {
    this._hwversion = await this.usb.controlInString(0xc0, 0x00, 0, 0);
    this._fwversion = await this.usb.controlInString(0xc0, 0x00, 0, 1);

    // Firmware >= 2.0 uses interleaved data format; older uses block format
    this.fwInterleaved = parseFloat(this._fwversion) >= 2.0;

    this.minSampleTime = 2.0 * M1K_MIN_PER / M1K_TIMER_CLOCK;

    // Stop any ongoing sampling
    await this.usb.controlOut(0x40, 0xc5, 0, 0);

    await this.readCalibration();

    await this.configure(0, M1K_DEFAULT_SAMPLE_TIME, Math.ceil(12.0 / M1K_DEFAULT_SAMPLE_TIME), true, false);
  }

  async close(): Promise<void> {
    await this.pauseCapture();
    await this.usb.close();
  }

  // --- Calibration ---

  async readCalibration(): Promise<M1KCalibration> {
    const cal = defaultCal();
    try {
      const d = await this.usb.controlIn(0xc0, 0x01, 0, 0, M1K_EEPROM_CAL_SIZE);
      if (d.byteLength >= M1K_EEPROM_CAL_SIZE && d.getUint32(0, true) === M1K_EEPROM_VALID) {
        cal.valid = true;
        for (let i = 0; i < 8; i++) {
          cal.offset[i] = d.getFloat32(4 + i * 4, true);
          cal.gain_p[i] = d.getFloat32(36 + i * 4, true);
          cal.gain_n[i] = d.getFloat32(68 + i * 4, true);
        }
      }
    } catch {
      // fall through to defaults
    }

    if (!cal.valid) {
      console.error('M1K: calibration data invalid, using defaults');
    }
    this.cal = cal;
    return cal;
  }

  async writeCalibration(cal: M1KCalibration): Promise<void> {
    const buf = new Uint8Array(M1K_EEPROM_CAL_SIZE);
    const d = new DataView(buf.buffer);
    d.setUint32(0, M1K_EEPROM_VALID, true);
    for (let i = 0; i < 8; i++) {
      d.setFloat32(4 + i * 4, cal.offset[i], true);
      d.setFloat32(36 + i * 4, cal.gain_p[i], true);
      d.setFloat32(68 + i * 4, cal.gain_n[i], true);
    }
    await this.usb.controlOut(0x40, 0x02, 0, 0, buf);
    this.cal = { ...cal, valid: true };
  }

  async resetCalibration(): Promise<void> {
    const cal = defaultCal();
    await this.writeCalibration(cal);
  }

  // --- Configuration ---

  async configure(mode: number, sampleTime: number, samples: number, continuous: boolean, raw: boolean): Promise<void> {
    await this.pauseCapture();

    this.channelA.source = null;
    this.channelB.source = null;
    this.channels = [];
    this.channelA.streams = [];
    this.channelB.streams = [];

    // Compute timer period (matches libsmu: sam_per = round(sample_time * clock) / 2)
    // Each sample takes 2 timer ticks (A-phase + B-phase), so actual
    // sample period = 2 * m1kPer / clock.
    this.m1kPer = Math.round(sampleTime * M1K_TIMER_CLOCK) / 2;
    if (this.m1kPer < M1K_MIN_PER) this.m1kPer = M1K_MIN_PER;
    if (this.m1kPer > M1K_MAX_PER) this.m1kPer = M1K_MAX_PER;
    this.sampleTime = 2.0 * this.m1kPer / M1K_TIMER_CLOCK;

    this.captureSamples = samples;
    this.captureContinuous = continuous;
    if (mode !== 0) {
      // M1K only implements mode 0; anything else would leave channels
      // and sample buffers unconfigured and crash the capture path
      console.error(`M1K: unsupported mode ${mode} requested, using 0`);
      mode = 0;
    }
    this.devMode = mode;
    this.rawMode = raw;
    this.captureLength = this.captureSamples * this.sampleTime;

    this.packetsPerTransfer = Math.ceil(M1K_BUFFER_TIME / (this.sampleTime * M1K_CHUNK_SIZE) / M1K_N_TRANSFERS);
    if (this.packetsPerTransfer < 1) this.packetsPerTransfer = 1;

    this.capture_i = this.capture_o = 0;
    this.resetLeadTracking();

    this.channels.push(this.channelA);
    this.channelA.source = makeConstantSource(0, 0);
    this.channelA.streams.push(this.channelAV, this.channelAI);

    this.channels.push(this.channelB);
    this.channelB.source = makeConstantSource(0, 0);
    this.channelB.streams.push(this.channelBV, this.channelBI);

    if (this.rawMode) {
      this.channelAV.units = this.channelBV.units = 'LSB';
      this.channelAI.units = this.channelBI.units = 'LSB';
      this.channelAV.min = this.channelBV.min = 0;
      this.channelAV.max = this.channelBV.max = 65535;
      this.channelAI.min = this.channelBI.min = 0;
      this.channelAI.max = this.channelBI.max = 65535;
    } else {
      this.channelAV.units = this.channelBV.units = 'V';
      this.channelAI.units = this.channelBI.units = 'mA';
      this.channelAV.min = this.channelBV.min = M1K_V_MIN;
      this.channelAV.max = this.channelBV.max = M1K_V_MAX;
      this.channelAI.min = this.channelBI.min = M1K_I_MIN;
      this.channelAI.max = this.channelBI.max = M1K_I_MAX;
    }

    this.channelAV.allocate(this.captureSamples);
    this.channelAI.allocate(this.captureSamples);
    this.channelBV.allocate(this.captureSamples);
    this.channelBI.allocate(this.captureSamples);

    this.notifyConfig();
  }

  // --- Mode control ---

  async setMode(channel: 0 | 1, mode: M1KMode): Promise<void> {
    const split = mode === M1KMode.HI_Z_SPLIT || mode === M1KMode.SVMI_SPLIT || mode === M1KMode.SIMV_SPLIT;
    const baseModeForPset = mode % 3; // 0=HI_Z, 1=SVMI, 2=SIMV
    const pset = baseModeForPset === 2 ? 0x7f7f : baseModeForPset === 1 ? 0x0000 : 0x3000;

    // Set feedback potentiometers
    await this.usb.controlOut(0x40, 0x59, channel, pset);

    // Set mode (firmware only understands 0/1/2)
    await this.usb.controlOut(0x40, 0x53, channel, mode % 3);

    // Set SPLIT pin for split modes
    if (split) {
      const pin = channel === 0 ? PIN.CHA_SPLIT : PIN.CHB_SPLIT;
      await this.usb.controlOut(0x40, 0x51, pin, 0);
    }

    this.mode[channel] = mode;

    // Update frontend cache to match what firmware set_mode() does to the GPIO pins
    // Firmware set_mode: DISABLED => feedback on (PBx clear), output_en off (PBx set)
    //                    SVMI/SIMV => feedback on (PBx clear), output_en on (PBx clear)
    const baseMode = mode % 3; // 0=HI_Z, 1=SVMI, 2=SIMV
    const fe = this.frontend[channel];
    fe.feedback = true; // firmware always clears feedback pin (active LOW = on)
    fe.output_en = baseMode !== 0; // on for SVMI/SIMV, off for HI_Z/DISABLED
    fe.split = split;
    fe.pot_r1 = (pset >> 8) & 0xff;
    fe.pot_r2 = pset & 0xff;
  }

  // --- Capture control ---

  protected async onResetCapture(): Promise<void> {
    if (this.channelA.source) this.channelA.source.startSample = 0;
    if (this.channelB.source) this.channelB.source.startSample = 0;
  }

  protected async onStartCapture(): Promise<void> {
    // Set alt setting 1 for streaming
    await this.usb.selectAlternate(1);

    // Set channel modes
    await this.setMode(0, this.mode[0]);
    await this.setMode(1, this.mode[1]);

    // Stop any ongoing sampling
    await this.usb.controlOut(0x40, 0xc5, 0, 0);

    // Initialize hardware
    await this.usb.controlOut(0x40, 0xcc, 0, 0);

    // Sync SOF
    const sofData = await this.usb.controlIn(0xc0, 0x6f, 0, 0, 2);
    let sofStart = sofData.getUint16(0, true);
    sofStart = ((((sofStart >> 3) + 0x1f) & 0x7ff) << 3) & 0xffff;

    // Start sampling
    await this.usb.controlOut(0x40, 0xc5, this.m1kPer, sofStart);

    // Ignore output samples sent before pausing
    this.capture_o = this.capture_i;
    this.resetLeadTracking();

    this.inPump = new InPump(
      this.usb, EP_BULK_IN,
      M1K_IN_PACKET_SIZE * this.packetsPerTransfer, M1K_N_TRANSFERS,
      (d) => this.handleInTransfer(d),
      (e) => this.onStreamError(e),
    );
    this.outPump = new OutPump(
      this.usb, EP_BULK_OUT,
      M1K_OUT_PACKET_SIZE * this.packetsPerTransfer, M1K_N_TRANSFERS,
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

    // Stop sampling
    await this.usb.controlOut(0x40, 0xc5, 0, 0);

    // Reset modes to HI_Z
    await this.setMode(0, M1KMode.HI_Z);
    await this.setMode(1, M1KMode.HI_Z);

    // Abort pending bulk transfers and return to the non-streaming alt setting
    await this.usb.abortTransfers(0);
    await stopping;

    this.capture_o = this.capture_i;
    this.resetLeadTracking();
  }

  private onStreamError(e: Error): void {
    console.error('M1K stream error:', e);
    this.error.notify(e);
    void this.pauseCapture();
  }

  // --- IN transfer decoding ---

  private handleInTransfer(data: DataView): void {
    const npackets = Math.floor(data.byteLength / M1K_IN_PACKET_SIZE);
    const cal = this.cal;

    for (let p = 0; p < npackets; p++) {
      const base = p * M1K_IN_PACKET_SIZE;

      for (let i = 0; i < M1K_CHUNK_SIZE; i++) {
        let rawAV: number, rawAI: number, rawBV: number, rawBI: number;

        if (this.fwInterleaved) {
          // Firmware >= 2.0: interleaved [AV, AI, BV, BI] per sample
          rawAV = data.getUint16(base + i * 8 + 0, false);
          rawAI = data.getUint16(base + i * 8 + 2, false);
          rawBV = data.getUint16(base + i * 8 + 4, false);
          rawBI = data.getUint16(base + i * 8 + 6, false);
        } else {
          // Firmware < 2.0: block format [all AV][all AI][all BV][all BI]
          rawAV = data.getUint16(base + (i + M1K_CHUNK_SIZE * 0) * 2, false);
          rawAI = data.getUint16(base + (i + M1K_CHUNK_SIZE * 1) * 2, false);
          rawBV = data.getUint16(base + (i + M1K_CHUNK_SIZE * 2) * 2, false);
          rawBI = data.getUint16(base + (i + M1K_CHUNK_SIZE * 3) * 2, false);
        }

        if (this.rawMode) {
          this.put(this.channelAV, rawAV);
          this.put(this.channelAI, rawAI);
          this.put(this.channelBV, rawBV);
          this.put(this.channelBI, rawBI);
        } else {
          // Channel A voltage
          let v = rawAV * M1K_V_RESOLUTION;
          this.put(this.channelAV, (v - cal.offset[0]) * cal.gain_p[0]);

          // Channel A current: scale to mA
          v = (rawAI * M1K_I_RESOLUTION - 0.195) * 1.25;
          const ai = (v - cal.offset[1]) * (v > 0 ? cal.gain_p[1] : cal.gain_n[1]);
          this.put(this.channelAI, ai * 1000.0); // A -> mA

          // Channel B voltage
          v = rawBV * M1K_V_RESOLUTION;
          this.put(this.channelBV, (v - cal.offset[4]) * cal.gain_p[4]);

          // Channel B current: scale to mA
          v = (rawBI * M1K_I_RESOLUTION - 0.195) * 1.25;
          const bi = (v - cal.offset[5]) * (v > 0 ? cal.gain_p[5] : cal.gain_n[5]);
          this.put(this.channelBI, bi * 1000.0); // A -> mA
        }

        this.sampleDone();
      }
    }

    this.packetDone();
    this.checkOutputEffective(this.channelA);
    this.checkOutputEffective(this.channelB);

    // --- Output/input stream resync ---
    // capture_o (encode position) and capture_i (capture position) advance
    // in lockstep with a fixed queue lead. Scheduling stalls (tab
    // throttling, GC pauses) can let the device replay stale ring data
    // while encoding pauses, permanently shifting that lead - and with it
    // the phase relationship out-source triggers depend on. Track the
    // per-window minimum lead and re-anchor capture_o when it drifts; the
    // correction causes a one-time output glitch of |drift| samples but
    // restores index-space alignment.
    const lead = this.capture_o - this.capture_i;
    if (this.leadSettle > 0) {
      this.leadSettle--;
    } else {
      if (lead < this.leadMin) this.leadMin = lead;
      if (++this.leadCount >= 64) {
        if (this.leadBaseline === null) {
          this.leadBaseline = this.leadMin;
        } else {
          const drift = this.leadMin - this.leadBaseline;
          if (Math.abs(drift) > M1K_CHUNK_SIZE / 2) {
            this.capture_o -= drift;
            console.warn(`M1K: output stream resynced by ${-drift} samples`);
          }
        }
        this.leadMin = Infinity;
        this.leadCount = 0;
      }
    }
  }

  private resetLeadTracking(): void {
    this.leadBaseline = null;
    this.leadMin = Infinity;
    this.leadCount = 0;
    this.leadSettle = 16;
  }

  // --- OUT transfer encoding ---

  private encodeOut(channel: 0 | 1, val: number): number {
    let v = (32768 * 4) / 5; // HI_Z midscale default

    if (this.rawMode) {
      return constrain(val, 0, 65535);
    }

    const mode = this.mode[channel];
    const cal = this.cal;

    if (mode === M1KMode.SVMI || mode === M1KMode.SVMI_SPLIT) {
      // val is in V, apply source calibration
      val = (val - cal.offset[channel * 4 + 2]) * cal.gain_p[channel * 4 + 2];
      val = constrain(val, M1K_V_MIN, M1K_V_MAX);
      v = val * (1.0 / M1K_V_RESOLUTION);
    } else if (mode === M1KMode.SIMV || mode === M1KMode.SIMV_SPLIT) {
      // val is in mA, convert to A for encoding
      let valA = val / 1000.0;
      if (valA > 0) {
        valA = (valA - cal.offset[channel * 4 + 3]) * cal.gain_p[channel * 4 + 3];
      } else {
        valA = (valA - cal.offset[channel * 4 + 3]) * cal.gain_n[channel * 4 + 3];
      }
      valA = constrain(valA, -0.2, 0.2);
      v = 65536 * (2.0 / 5.0 + 0.8 * 0.2 * 20.0 * 0.5 * valA);
    }

    return constrain(Math.trunc(v), 0, 65535);
  }

  private fillOutTransfer(buf: Uint8Array): void {
    const srcA = this.channelA.source;
    const srcB = this.channelB.source;

    if (srcA && srcB) {
      for (let p = 0; p < this.packetsPerTransfer; p++) {
        const base = p * M1K_OUT_PACKET_SIZE;

        for (let i = 0; i < M1K_CHUNK_SIZE; i++) {
          const a = this.encodeOut(0, srcA.getValue(this.capture_o, this.sampleTime));
          const b = this.encodeOut(1, srcB.getValue(this.capture_o, this.sampleTime));

          if (this.fwInterleaved) {
            // Firmware >= 2.0: interleaved [A_hi, A_lo, B_hi, B_lo]
            buf[base + i * 4 + 0] = a >> 8;
            buf[base + i * 4 + 1] = a & 0xff;
            buf[base + i * 4 + 2] = b >> 8;
            buf[base + i * 4 + 3] = b & 0xff;
          } else {
            // Firmware < 2.0: block [all A][all B]
            buf[base + (i + M1K_CHUNK_SIZE * 0) * 2] = a >> 8;
            buf[base + (i + M1K_CHUNK_SIZE * 0) * 2 + 1] = a & 0xff;
            buf[base + (i + M1K_CHUNK_SIZE * 1) * 2] = b >> 8;
            buf[base + (i + M1K_CHUNK_SIZE * 1) * 2 + 1] = b & 0xff;
          }

          this.capture_o++;
        }
      }
    } else {
      buf.fill(0);
    }
  }

  // --- Output management ---

  override async setOutput(channel: Channel, source: OutputSource): Promise<void> {
    source.initialize(this.capture_o, channel.source);
    channel.source = source;
    channel.source.startSample = this.capture_o + 1;

    // Update hardware mode if the output mode changed
    const ch: 0 | 1 = channel === this.channelA ? 0 : 1;
    if (this.mode[ch] !== source.mode) {
      if (this.captureState) {
        await this.setMode(ch, source.mode as M1KMode);
      } else {
        this.mode[ch] = source.mode;
      }
    }

    this.notifyOutputChanged(channel, source);
  }

  private checkOutputEffective(channel: Channel): void {
    if (!channel.source) return;
    if (!channel.source.effective && this.capture_i > channel.source.startSample) {
      channel.source.effective = true;
      this.notifyOutputChanged(channel, channel.source);
    }
  }

  // --- GPIO helpers ---

  async setGPIO(pin: number, high: boolean): Promise<void> {
    await this.usb.controlOut(0x40, high ? 0x51 : 0x50, pin, 0);
  }

  async setDigipot(channel: 0 | 1, r1: number, r2: number): Promise<void> {
    await this.usb.controlOut(0x40, 0x59, channel, ((r1 & 0xff) << 8) | (r2 & 0xff));
    this.frontend[channel].pot_r1 = r1;
    this.frontend[channel].pot_r2 = r2;
  }

  async setFrontendSwitch(ch: 0 | 1, name: M1KFrontendSwitch, val: boolean): Promise<void> {
    // GPIO switches are active LOW: val=true means switch ON = pin LOW
    const fe = this.frontend[ch];
    let pin: number;
    switch (name) {
      case 'r50_2v5':
        pin = ch === 0 ? PIN.CHA_50R_2V5 : PIN.CHB_50R_2V5;
        fe.r50_2v5 = val;
        break;
      case 'r50_gnd':
        pin = ch === 0 ? PIN.CHA_50R_GND : PIN.CHB_50R_GND;
        fe.r50_gnd = val;
        break;
      case 'feedback':
        pin = ch === 0 ? PIN.CHA_FEEDBACK : PIN.CHB_FEEDBACK;
        fe.feedback = val;
        break;
      case 'output_en':
        pin = ch === 0 ? PIN.CHA_OUTPUT_EN : PIN.CHB_OUTPUT_EN;
        fe.output_en = val;
        break;
      case 'split':
        pin = ch === 0 ? PIN.CHA_SPLIT : PIN.CHB_SPLIT;
        fe.split = val;
        // SPLIT pin is active HIGH (opposite of others)
        await this.setGPIO(pin, val);
        return;
    }
    // Active LOW switches: true = ON = pin LOW
    await this.setGPIO(pin, !val);
  }

  // --- ADM1177 power monitoring ---

  async readPower(): Promise<{ statusRaw: number; alertBit: number; overcurrent: boolean }> {
    const d = await this.usb.controlIn(0xc0, 0x17, 0, 3, 3);
    const statusRaw = d.byteLength >= 1 ? d.getUint8(0) : 0;
    // Alert bit position depends on firmware version
    const alertBit = this._fwversion >= '2.11' ? 0x8 : 0x4;
    return { statusRaw, alertBit, overcurrent: (statusRaw & alertBit) !== 0 };
  }

  // --- Temperature ---

  async readTemperature(): Promise<{ a: number; b: number }> {
    const read = async (idx: number): Promise<number> => {
      const d = await this.usb.controlIn(0xc0, 0x19, idx, 0, 2);
      return d.byteLength >= 2 ? d.getUint16(0, false) : 0;
    };
    return { a: await read(0), b: await read(1) };
  }

  // --- LEDs ---

  get leds(): { red: boolean; green: boolean; blue: boolean } {
    return {
      red: (this.ledState & 0x4) !== 0,
      green: (this.ledState & 0x2) !== 0,
      blue: (this.ledState & 0x1) !== 0,
    };
  }

  async setLEDs(state: number): Promise<void> {
    this.ledState = state & 0x7;
    await this.usb.controlOut(0x40, 0x03, this.ledState, 0);
  }

  // --- Serial number ---

  async setSerial(newSerial: string): Promise<void> {
    if (newSerial.length === 0 || newSerial.length > 32) {
      throw new Error('Serial must be 1-32 characters');
    }
    const data = new Uint8Array(newSerial.length);
    for (let i = 0; i < newSerial.length; i++) {
      data[i] = newSerial.charCodeAt(i) & 0xff;
    }
    await this.usb.controlOut(0x40, 0x05, 0, 0, data);
  }
}
