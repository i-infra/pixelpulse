/**
 * Device discovery and hotplug.
 *
 * Replaces connect/usb.cpp (libusb hotplug + VID/PID dispatch) with
 * navigator.usb. WebUSB requires a user gesture to grant access to a new
 * device (requestDevice); previously-granted devices are listed by
 * getDevices() and reattach without a prompt.
 */

import { TypedEvent } from './events';
import { CEEDevice } from './cee';
import { M1KDevice } from './m1k';
import { BootloaderDevice } from './bootloader';

export type SMUDevice = CEEDevice | M1KDevice | BootloaderDevice;

const NONOLITH_VID = 0x59e3;
const NONOLITH_DEV_VID = 0x9999;
const CEE_PID = 0xcee1;
const BOOTLOADER_PID = 0xbbbb;
const BOOTLOADER_DEV_PID = 0xb003;

const ADI_VID = 0x0456;
const M1K_PID = 0xcee2;
const ADI_VID2 = 0x064b;
const M1K_PID2 = 0x784c;

export const USB_FILTERS: USBDeviceFilter[] = [
  { vendorId: NONOLITH_VID, productId: CEE_PID },
  { vendorId: NONOLITH_VID, productId: BOOTLOADER_PID },
  { vendorId: NONOLITH_DEV_VID, productId: CEE_PID },
  { vendorId: NONOLITH_DEV_VID, productId: BOOTLOADER_PID },
  { vendorId: NONOLITH_DEV_VID, productId: BOOTLOADER_DEV_PID },
  { vendorId: ADI_VID, productId: M1K_PID },
  { vendorId: ADI_VID2, productId: M1K_PID2 },
];

export function isSupported(): boolean {
  return typeof navigator !== 'undefined' && 'usb' in navigator;
}

function matchesFilters(device: USBDevice): boolean {
  return USB_FILTERS.some(
    (f) => device.vendorId === f.vendorId && device.productId === f.productId,
  );
}

/** Open the appropriate driver for a USB device, dispatching on VID/PID. */
export async function openDevice(device: USBDevice): Promise<SMUDevice> {
  const { vendorId, productId } = device;

  if (vendorId === NONOLITH_VID || vendorId === NONOLITH_DEV_VID) {
    if (productId === CEE_PID) {
      return CEEDevice.open(device);
    }
    if (productId === BOOTLOADER_PID || productId === BOOTLOADER_DEV_PID) {
      return BootloaderDevice.open(device);
    }
  } else if (
    (vendorId === ADI_VID && productId === M1K_PID) ||
    (vendorId === ADI_VID2 && productId === M1K_PID2)
  ) {
    return M1KDevice.open(device);
  }

  throw new Error(
    `Unsupported device ${vendorId.toString(16)}:${productId.toString(16)}`,
  );
}

/**
 * Tracks attached (permission-granted) SMU hardware and opens drivers.
 *
 * Typical use:
 *   const session = new SMUSession();
 *   session.devicesChanged.subscribe((devs) => render(devs));
 *   await session.start();                 // attach already-granted devices
 *   button.onclick = () => session.requestDevice(); // pair a new one
 *   const dev = await session.open(session.available[0]);
 */
export class SMUSession {
  /** Permission-granted, currently-attached matching USB devices */
  available: USBDevice[] = [];

  devicesChanged = new TypedEvent<[USBDevice[]]>();
  deviceAttached = new TypedEvent<[USBDevice]>();
  deviceDetached = new TypedEvent<[USBDevice]>();

  private opened = new Map<USBDevice, SMUDevice>();
  private started = false;

  private onConnect = (ev: USBConnectionEvent): void => {
    if (!matchesFilters(ev.device)) return;
    this.available.push(ev.device);
    this.deviceAttached.notify(ev.device);
    this.devicesChanged.notify(this.available);
  };

  private onDisconnect = (ev: USBConnectionEvent): void => {
    const i = this.available.indexOf(ev.device);
    if (i === -1) return;
    this.available.splice(i, 1);

    const driver = this.opened.get(ev.device);
    if (driver) {
      this.opened.delete(ev.device);
      if ('onDisconnect' in driver) {
        driver.onDisconnect();
      }
    }

    this.deviceDetached.notify(ev.device);
    this.devicesChanged.notify(this.available);
  };

  /** Enumerate already-granted devices and begin watching hotplug events. */
  async start(): Promise<USBDevice[]> {
    if (!isSupported()) {
      throw new Error('WebUSB is not supported in this browser');
    }
    if (!this.started) {
      this.started = true;
      navigator.usb.addEventListener('connect', this.onConnect);
      navigator.usb.addEventListener('disconnect', this.onDisconnect);
    }
    const devices = await navigator.usb.getDevices();
    this.available = devices.filter(matchesFilters);
    this.devicesChanged.notify(this.available);
    return this.available;
  }

  stop(): void {
    if (this.started) {
      this.started = false;
      navigator.usb.removeEventListener('connect', this.onConnect);
      navigator.usb.removeEventListener('disconnect', this.onDisconnect);
    }
  }

  /**
   * Show the browser device chooser to grant access to a new device.
   * Must be called from a user gesture (e.g. a click handler).
   * Returns null if the user cancels the chooser.
   */
  async requestDevice(): Promise<USBDevice | null> {
    let device: USBDevice;
    try {
      device = await navigator.usb.requestDevice({ filters: USB_FILTERS });
    } catch {
      return null; // user cancelled
    }
    if (!this.available.includes(device)) {
      this.available.push(device);
      this.devicesChanged.notify(this.available);
    }
    return device;
  }

  /** Open (or return the already-open) driver for a USB device. */
  async open(device: USBDevice): Promise<SMUDevice> {
    const existing = this.opened.get(device);
    if (existing) return existing;
    const driver = await openDevice(device);
    this.opened.set(device, driver);
    return driver;
  }

  /** Close the driver for a USB device, if open. */
  async close(device: USBDevice): Promise<void> {
    const driver = this.opened.get(device);
    if (driver) {
      this.opened.delete(device);
      await driver.close();
    }
  }
}
