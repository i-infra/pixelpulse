/**
 * Xmega bootloader driver (CEE firmware update).
 *
 * Port of connect/bootloader/bootloader.{hpp,cpp} to WebUSB. The device
 * enumerates as 0x59e3:0xBBBB when in bootloader mode; CEEDevice
 * .enterBootloader() makes a running CEE re-enumerate as this device.
 * Note: the bootloader PID is a different device to WebUSB, so the user
 * must grant permission for it separately (once per unit).
 */

import { UsbTransport } from './usb';

const REQ_INFO = 0xb0;
const REQ_ERASE = 0xb1;
const REQ_START_WRITE = 0xb2;
const REQ_CRC_APP = 0xb3;
const REQ_CRC_BOOT = 0xb4;
const REQ_RESET = 0xbf;

const EP_BULK_OUT = 1;

export interface BootloaderInfo {
  magic: number;
  version: number;
  devid: number;
  /** Page size in bytes */
  pageSize: number;
  /** Byte address of end of flash. Add one for flash size */
  appSectionEnd: number;
  /** App code can jump to this pointer to enter the bootloader */
  entryJmpPointer: number;
  hwProduct: string;
  hwVersion: string;
}

function decodeFixedString(d: DataView, offset: number, length: number): string {
  const bytes = new Uint8Array(d.buffer, d.byteOffset + offset, length);
  let end = bytes.indexOf(0);
  if (end === -1) end = length;
  return String.fromCharCode(...bytes.subarray(0, end));
}

export class BootloaderDevice {
  info: BootloaderInfo = {
    magic: 0,
    version: 0,
    devid: 0,
    pageSize: 0,
    appSectionEnd: 0,
    entryJmpPointer: 0,
    hwProduct: '',
    hwVersion: '',
  };

  private constructor(public readonly usb: UsbTransport) {}

  get model(): string {
    return 'com.nonolithlabs.bootloader';
  }

  get hwVersion(): string {
    return `${this.info.hwProduct} ${this.info.hwVersion}`;
  }

  get fwVersion(): string {
    return 'unknown';
  }

  get serial(): string {
    return this.usb.serial;
  }

  static async open(device: USBDevice): Promise<BootloaderDevice> {
    const usb = new UsbTransport(device);
    await usb.open();
    const dev = new BootloaderDevice(usb);
    await dev.getInfo();
    return dev;
  }

  async close(): Promise<void> {
    await this.usb.close();
  }

  async getInfo(): Promise<BootloaderInfo> {
    // BootloaderInfo struct: u32 magic, u8 version, u32 devid, u16 page_size,
    // u32 app_section_end, u32 entry_jmp_pointer, char[16] x2 (packed LE)
    const d = await this.usb.controlIn(0xc0, REQ_INFO, 0, 0, 51);
    this.info = {
      magic: d.getUint32(0, true),
      version: d.getUint8(4),
      devid: d.getUint32(5, true),
      pageSize: d.getUint16(9, true),
      appSectionEnd: d.getUint32(11, true),
      entryJmpPointer: d.getUint32(15, true),
      hwProduct: decodeFixedString(d, 19, 16),
      hwVersion: decodeFixedString(d, 35, 16),
    };
    return this.info;
  }

  async erase(): Promise<void> {
    await this.usb.controlIn(0xc0, REQ_ERASE, 0, 0, 0);
  }

  /** Write a firmware image to the application flash section. */
  async write(data: Uint8Array<ArrayBuffer>): Promise<void> {
    await this.usb.controlIn(0xc0, REQ_START_WRITE, 0, 0, 0);
    const r = await this.usb.device.transferOut(EP_BULK_OUT, data);
    if (r.status !== 'ok' || r.bytesWritten !== data.byteLength) {
      throw new Error(`Bootloader write failed: ${r.status}, wrote ${r.bytesWritten}/${data.byteLength}`);
    }
  }

  async crcApp(): Promise<number> {
    const d = await this.usb.controlIn(0xc0, REQ_CRC_APP, 0, 0, 64);
    return d.getUint32(0, true);
  }

  async crcBoot(): Promise<number> {
    const d = await this.usb.controlIn(0xc0, REQ_CRC_BOOT, 0, 0, 64);
    return d.getUint32(0, true);
  }

  /** Reset into the application firmware. The device re-enumerates. */
  async reset(): Promise<void> {
    await this.usb.controlIn(0xc0, REQ_RESET, 0, 0, 0).catch(() => {
      // the device resets without completing the transfer
    });
  }
}
