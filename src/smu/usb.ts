/**
 * WebUSB transport helpers.
 *
 * Replaces the libusb layer of Nonolith Connect (usb.cpp / usb_device.hpp):
 *  - UsbTransport wraps a USBDevice with vendor control transfer helpers
 *    using raw bmRequestType values, matching the firmware protocol docs.
 *  - InPump / OutPump replicate libusb's ring of queued asynchronous bulk
 *    transfers: N transfers are kept in flight on an endpoint, and each
 *    completion synchronously processes/refills its buffer and resubmits.
 *
 * Cancellation: WebUSB cannot abort an individual transfer. Pending
 * transfers on an interface are aborted by re-selecting its alternate
 * setting (or releasing it), so capture teardown is: tell the device to
 * stop sampling, then call UsbTransport.abortTransfers().
 */

function decodeSetup(bmRequestType: number, bRequest: number, wValue: number, wIndex: number): USBControlTransferParameters {
  const typeBits = (bmRequestType >> 5) & 0x3;
  const requestType: USBRequestType = typeBits === 0 ? 'standard' : typeBits === 1 ? 'class' : 'vendor';
  const recipBits = bmRequestType & 0x1f;
  const recipient: USBRecipient =
    recipBits === 0 ? 'device' : recipBits === 1 ? 'interface' : recipBits === 2 ? 'endpoint' : 'other';
  return { requestType, recipient, request: bRequest, value: wValue, index: wIndex };
}

export class UsbError extends Error {}

export class UsbTransport {
  constructor(public readonly device: USBDevice, public readonly interfaceNumber = 0) {}

  get serial(): string {
    return this.device.serialNumber ?? '';
  }

  async open(): Promise<void> {
    await this.device.open();
    if (!this.device.configuration) {
      await this.device.selectConfiguration(1);
    }
    await this.device.claimInterface(this.interfaceNumber);
  }

  async close(): Promise<void> {
    if (this.device.opened) {
      await this.device.close();
    }
  }

  /** IN control transfer. Returns the data; throws on stall. */
  async controlIn(bmRequestType: number, bRequest: number, wValue: number, wIndex: number, wLength: number): Promise<DataView> {
    const r = await this.device.controlTransferIn(decodeSetup(bmRequestType, bRequest, wValue, wIndex), wLength);
    if (r.status !== 'ok' || !r.data) {
      throw new UsbError(`control IN req=0x${bRequest.toString(16)} failed: ${r.status}`);
    }
    return r.data;
  }

  /** OUT control transfer. Returns bytes written; throws on stall. */
  async controlOut(bmRequestType: number, bRequest: number, wValue: number, wIndex: number, data?: BufferSource): Promise<number> {
    const r = await this.device.controlTransferOut(decodeSetup(bmRequestType, bRequest, wValue, wIndex), data);
    if (r.status !== 'ok') {
      throw new UsbError(`control OUT req=0x${bRequest.toString(16)} failed: ${r.status}`);
    }
    return r.bytesWritten;
  }

  /** Read a NUL-terminated ASCII string via a vendor IN request. */
  async controlInString(bmRequestType: number, bRequest: number, wValue: number, wIndex: number, wLength = 64): Promise<string> {
    const d = await this.controlIn(bmRequestType, bRequest, wValue, wIndex, wLength);
    const bytes = new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
    let end = bytes.indexOf(0);
    if (end === -1) end = bytes.length;
    return String.fromCharCode(...bytes.subarray(0, end));
  }

  async selectAlternate(alternateSetting: number): Promise<void> {
    await this.device.selectAlternateInterface(this.interfaceNumber, alternateSetting);
  }

  /**
   * Abort all pending transfers on the interface. Re-selecting the current
   * alternate setting cancels pending transfers per the WebUSB spec; fall
   * back to release/claim if the device rejects SET_INTERFACE.
   */
  async abortTransfers(alternateSetting = 0): Promise<void> {
    try {
      await this.device.selectAlternateInterface(this.interfaceNumber, alternateSetting);
    } catch {
      await this.device.releaseInterface(this.interfaceNumber);
      await this.device.claimInterface(this.interfaceNumber);
    }
  }
}

/**
 * Ring of queued bulk IN transfers.
 *
 * `onData` must be synchronous: completion callbacks run in transfer
 * completion order, and processing the buffer before yielding to the event
 * loop is what keeps the sample stream in order with multiple transfers
 * in flight.
 */
export class InPump {
  private stopped = false;
  private workers: Promise<void>[] = [];

  constructor(
    private transport: UsbTransport,
    private endpoint: number,
    private transferSize: number,
    private depth: number,
    private onData: (data: DataView) => void,
    private onError: (e: Error) => void,
  ) {}

  start(): void {
    this.stopped = false;
    this.workers = [];
    for (let i = 0; i < this.depth; i++) {
      this.workers.push(this.run());
    }
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      let r: USBInTransferResult;
      try {
        r = await this.transport.device.transferIn(this.endpoint, this.transferSize);
      } catch (e) {
        if (!this.stopped) this.onError(e instanceof Error ? e : new UsbError(String(e)));
        return;
      }
      if (this.stopped) return;
      if (r.status !== 'ok' || !r.data) {
        this.onError(new UsbError(`bulk IN failed: ${r.status}`));
        return;
      }
      this.onData(r.data);
    }
  }

  /** Stop resubmitting. Pending transfers must be aborted via UsbTransport.abortTransfers(). */
  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled(this.workers);
    this.workers = [];
  }
}

/**
 * Ring of queued bulk OUT transfers. `fill` synchronously fills the buffer
 * with the next output samples before each (re)submission.
 */
export class OutPump {
  private stopped = false;
  private workers: Promise<void>[] = [];

  constructor(
    private transport: UsbTransport,
    private endpoint: number,
    private transferSize: number,
    private depth: number,
    private fill: (buf: Uint8Array) => void,
    private onError: (e: Error) => void,
  ) {}

  start(): void {
    this.stopped = false;
    this.workers = [];
    for (let i = 0; i < this.depth; i++) {
      this.workers.push(this.run());
    }
  }

  private async run(): Promise<void> {
    const buf = new Uint8Array(this.transferSize);
    while (!this.stopped) {
      this.fill(buf);
      try {
        const r = await this.transport.device.transferOut(this.endpoint, buf);
        if (this.stopped) return;
        if (r.status !== 'ok') {
          this.onError(new UsbError(`bulk OUT failed: ${r.status}`));
          return;
        }
      } catch (e) {
        if (!this.stopped) this.onError(e instanceof Error ? e : new UsbError(String(e)));
        return;
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled(this.workers);
    this.workers = [];
  }
}
