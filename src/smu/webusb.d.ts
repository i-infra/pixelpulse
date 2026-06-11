/**
 * Minimal ambient WebUSB type declarations.
 *
 * TypeScript's DOM lib does not ship WebUSB types. These cover the subset
 * of the spec (https://wicg.github.io/webusb/) used by this library, so it
 * has no dependency on @types/w3c-web-usb.
 */

interface USBDeviceFilter {
  vendorId?: number;
  productId?: number;
  classCode?: number;
  subclassCode?: number;
  protocolCode?: number;
  serialNumber?: string;
}

interface USBDeviceRequestOptions {
  filters: USBDeviceFilter[];
}

interface USBConnectionEvent extends Event {
  readonly device: USBDevice;
}

interface USB extends EventTarget {
  getDevices(): Promise<USBDevice[]>;
  requestDevice(options: USBDeviceRequestOptions): Promise<USBDevice>;
  onconnect: ((this: USB, ev: USBConnectionEvent) => void) | null;
  ondisconnect: ((this: USB, ev: USBConnectionEvent) => void) | null;
  addEventListener(
    type: 'connect' | 'disconnect',
    listener: (this: USB, ev: USBConnectionEvent) => void,
    useCapture?: boolean,
  ): void;
  removeEventListener(
    type: 'connect' | 'disconnect',
    listener: (this: USB, ev: USBConnectionEvent) => void,
    useCapture?: boolean,
  ): void;
}

interface Navigator {
  readonly usb: USB;
}

type USBRequestType = 'standard' | 'class' | 'vendor';
type USBRecipient = 'device' | 'interface' | 'endpoint' | 'other';
type USBTransferStatus = 'ok' | 'stall' | 'babble';

interface USBControlTransferParameters {
  requestType: USBRequestType;
  recipient: USBRecipient;
  request: number;
  value: number;
  index: number;
}

interface USBInTransferResult {
  readonly data?: DataView;
  readonly status?: USBTransferStatus;
}

interface USBOutTransferResult {
  readonly bytesWritten: number;
  readonly status?: USBTransferStatus;
}

interface USBEndpoint {
  readonly endpointNumber: number;
  readonly direction: 'in' | 'out';
  readonly type: 'bulk' | 'interrupt' | 'isochronous';
  readonly packetSize: number;
}

interface USBAlternateInterface {
  readonly alternateSetting: number;
  readonly interfaceClass: number;
  readonly interfaceSubclass: number;
  readonly interfaceProtocol: number;
  readonly interfaceName?: string;
  readonly endpoints: USBEndpoint[];
}

interface USBInterface {
  readonly interfaceNumber: number;
  readonly alternate: USBAlternateInterface;
  readonly alternates: USBAlternateInterface[];
  readonly claimed: boolean;
}

interface USBConfiguration {
  readonly configurationValue: number;
  readonly configurationName?: string;
  readonly interfaces: USBInterface[];
}

interface USBDevice {
  readonly usbVersionMajor: number;
  readonly usbVersionMinor: number;
  readonly usbVersionSubminor: number;
  readonly deviceClass: number;
  readonly deviceSubclass: number;
  readonly deviceProtocol: number;
  readonly vendorId: number;
  readonly productId: number;
  readonly deviceVersionMajor: number;
  readonly deviceVersionMinor: number;
  readonly deviceVersionSubminor: number;
  readonly manufacturerName?: string;
  readonly productName?: string;
  readonly serialNumber?: string;
  readonly configuration?: USBConfiguration;
  readonly configurations: USBConfiguration[];
  readonly opened: boolean;

  open(): Promise<void>;
  close(): Promise<void>;
  forget(): Promise<void>;
  selectConfiguration(configurationValue: number): Promise<void>;
  claimInterface(interfaceNumber: number): Promise<void>;
  releaseInterface(interfaceNumber: number): Promise<void>;
  selectAlternateInterface(interfaceNumber: number, alternateSetting: number): Promise<void>;
  controlTransferIn(setup: USBControlTransferParameters, length: number): Promise<USBInTransferResult>;
  controlTransferOut(setup: USBControlTransferParameters, data?: BufferSource): Promise<USBOutTransferResult>;
  clearHalt(direction: 'in' | 'out', endpointNumber: number): Promise<void>;
  transferIn(endpointNumber: number, length: number): Promise<USBInTransferResult>;
  transferOut(endpointNumber: number, data: BufferSource): Promise<USBOutTransferResult>;
  reset(): Promise<void>;
}
