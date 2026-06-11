/**
 * WebSocket backend: drives hardware through the Nonolith Connect daemon.
 *
 * This is the original dataserver transport (dataserver.coffee lineage).
 * It remains the right choice when WebUSB can't do the job:
 *   - multiple clients sharing one device (Connect fans out streams)
 *   - remote operation: Pixelpulse on one machine, Connect + hardware on
 *     another (`nonolith-connect --allow-remote`)
 *   - browsers without WebUSB (Firefox, Safari)
 *
 * Original: (C) 2011 Nonolith Labs, Kevin Mehall <km@kevinmehall.net>
 * Distributed under the terms of the GNU LGPLv3
 */

import {
  Dataserver, Device, CEEDevice, BootloaderDevice,
  removeNull,
} from './dataserver-common.js';
import type { DeviceInfo, CEEDeviceInfo, OutputSource, UpdateMessage, Reply } from './dataserver-common.js';

/** Messages received from Connect, discriminated on _action */
type ServerMessage =
  | { _action: 'serverHello'; version: string; gitVersion: string }
  | { _action: 'devices'; devices: Record<string, DeviceInfo> }
  | { _action: 'deviceDisconnected' }
  | { _action: 'return'; id: number; [key: string]: unknown }
  | { _action: 'deviceConfig'; device: CEEDeviceInfo }
  | { _action: 'captureState'; state: boolean; done: boolean }
  | { _action: 'captureReset' }
  | { _action: 'update'; id: number; idx: number; sampleIndex: number; subsample: number; data: number[][]; done: boolean }
  | { _action: 'outputChanged'; channel: string; source: string; mode: string; [key: string]: unknown }
  | { _action: 'gainChanged'; channel: string; stream: string; gain: number }
  | { _action: 'packetDrop' }
  | { _action: 'info'; [key: string]: unknown };

// Binary update frame (little-endian), mirroring stream_listener.cpp:
//   u8   type = 1 (stream update)
//   u8   flags: bit0 done, bit1 triggerForced, bit2 subsample valid
//   u16  stream count
//   u32  listener id
//   u32  idx
//   u32  sampleIndex
//   f32  subsample
//   u32  nchunks
//   f32  data[stream count][nchunks]
const BINARY_UPDATE_HEADER_SIZE = 24;

function parseBinaryUpdate(buf: ArrayBuffer): UpdateMessage | null {
  if (buf.byteLength < BINARY_UPDATE_HEADER_SIZE) {
    console.error('Binary frame too short:', buf.byteLength);
    return null;
  }

  const dv = new DataView(buf);
  const type = dv.getUint8(0);
  if (type !== 1) {
    console.error('Unknown binary frame type:', type);
    return null;
  }

  const flags = dv.getUint8(1);
  const nstreams = dv.getUint16(2, true);
  const id = dv.getUint32(4, true);
  const idx = dv.getUint32(8, true);
  const sampleIndex = dv.getUint32(12, true);
  const subsample = dv.getFloat32(16, true);
  const nchunks = dv.getUint32(20, true);

  if (buf.byteLength < BINARY_UPDATE_HEADER_SIZE + nstreams * nchunks * 4) {
    console.error('Binary frame truncated:', buf.byteLength, nstreams, nchunks);
    return null;
  }

  const data: Float32Array[] = [];
  for (let i = 0; i < nstreams; i++) {
    data.push(new Float32Array(buf, BINARY_UPDATE_HEADER_SIZE + i * nchunks * 4, nchunks));
  }

  return {
    _action: 'update',
    id, idx, sampleIndex, data,
    subsample: (flags & 4) ? subsample : (undefined as unknown as number),
    done: !!(flags & 1),
    triggerForced: !!(flags & 2),
  };
}

// --- WS Dataserver ---

export class WSDataserver extends Dataserver {
  private ws: WebSocket | null = null;

  constructor(public host: string) {
    super();
  }

  connect(): void {
    this.ws = new WebSocket(`ws://${this.host}/ws/v0`);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      console.log('connected to', this.host);
      this.connected.notify();
    };

    this.ws.onclose = () => {
      console.log('disconnected');
      this.disconnected.notify();
    };

    this.ws.onmessage = (evt: MessageEvent) => {
      if (evt.data instanceof ArrayBuffer) {
        const m = parseBinaryUpdate(evt.data);
        if (m) {
          (this.device as WSCEEDevice | null)?.onMessage(m as unknown as ServerMessage);
        }
        return;
      }

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
            (info) => new WSDevice(info),
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
          this.runCallback(m.id, m as unknown as Reply);
          break;

        default:
          (this.device as WSCEEDevice | WSBootloaderDevice | null)?.onMessage(m);
      }
    };
  }

  send(cmd: string, m: Record<string, unknown> = {}): void {
    m._cmd = cmd;
    this.ws!.send(JSON.stringify(m));
  }

  override selectDevice(device: Device): CEEDevice | BootloaderDevice {
    this.send('selectDevice', { id: device.id });
    return super.selectDevice(device);
  }
}

// --- WS Device (from the daemon's device list) ---

export class WSDevice extends Device {
  constructor(info: DeviceInfo) {
    super();
    this.id = info.id;
    this.model = info.model;
    this.serial = info.serial;
    this.hwVersion = removeNull(info.hwVersion);
    this.fwVersion = removeNull(info.fwVersion);
  }

  makeActiveObj(parent: Dataserver): CEEDevice | BootloaderDevice {
    switch (this.model) {
      case 'com.nonolithlabs.cee':
      case 'com.analogdevices.m1k':
        return new WSCEEDevice(parent);
      case 'com.nonolithlabs.bootloader':
        return new WSBootloaderDevice(parent);
      default:
        throw new Error(`Unknown device model: ${this.model}`);
    }
  }
}

// --- WS active devices: route daemon messages into the common base ---

export class WSCEEDevice extends CEEDevice {
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
        this.listenersById[m.id]?.onMessage(m as unknown as UpdateMessage);
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
}

export class WSBootloaderDevice extends BootloaderDevice {
  onMessage(m: ServerMessage): void {
    if (m._action === 'info') {
      this.onInfo(m as unknown as Record<string, unknown>);
    }
  }

  onInfo(info: Record<string, unknown>): void {
    this.serial = (info.serial as string) ?? '';
    this.magic = (info.magic as string) ?? '';
    this.version = (info.version as string) ?? '';
    this.devid = (info.devid as string) ?? '';
    this.page_size = (info.page_size as number) ?? 0;
    this.app_section_end = (info.app_section_end as number) ?? 0;
    this.hw_product = removeNull(info.hw_product as string);
    this.hw_version = removeNull(info.hw_version as string);
    this.changed.notify(this);
  }
}
