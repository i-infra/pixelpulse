/**
 * smu: WebUSB drivers for Nonolith CEE and ADALM1000 (M1K) source-measure
 * units, ported from the Nonolith Connect daemon.
 *
 * This library is self-contained (no dependencies on the Pixelpulse UI)
 * and is intended to be reusable in other applications. See README.md.
 */

export { TypedEvent } from './events';

export {
  OutputSource,
  ConstantSource,
  AdvSquareWaveSource,
  PeriodicSource,
  SineWaveSource,
  TriangleWaveSource,
  SquareWaveSource,
  ArbitraryWaveformSource,
  makeSource,
  makeConstantSource,
  makePeriodicSource,
} from './output-source';
export type { OutputSourceDescription, SourceDescription, ArbWavePoint } from './output-source';

export { Stream, Channel, StreamingDevice } from './streaming-device';
export type { DeviceInfo } from './streaming-device';

export { UsbTransport, UsbError, InPump, OutPump } from './usb';

export { CEEDevice, CEEChanMode } from './cee';
export type { CEECalibration } from './cee';

export { M1KDevice, M1KMode, M1K_MODE_NAMES, M1K_EEPROM_VALID } from './m1k';
export type { M1KCalibration, M1KFrontend, M1KFrontendSwitch } from './m1k';

export { BootloaderDevice } from './bootloader';
export type { BootloaderInfo } from './bootloader';

export { StreamListener, TriggerType } from './listener';
export type {
  StreamListenerConfig,
  StreamUpdate,
  TriggerConfig,
  InStreamTriggerConfig,
  OutSourceTriggerConfig,
} from './listener';

export { SMUSession, USB_FILTERS, isSupported, openDevice } from './session';
export type { SMUDevice } from './session';
