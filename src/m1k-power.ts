/**
 * M1K USB bus power readback via the ADM1177 hot-swap controller
 * (vendor request 0xC0/0x17: simultaneous V+I conversion, 3 bytes:
 * [V11:4, I11:4, V3:0 | I3:0]).
 */

import type { CEEDevice } from './dataserver.js';

export interface VBusReading {
  voltage: number;   // volts
  currentMA: number; // milliamps
}

// ADM1177 full scales: 6.65 V (VRANGE high); current sense 105.84 mV
// across the 0.1 ohm shunt -> 1058.4 mA full scale. (The sense amp's 10x
// gain is already folded into the 105.84 mV figure.)
const VBUS_V_FULLSCALE = 6.65;
const VBUS_MA_FULLSCALE = 105.84 / 0.1; // 1058.4 mA

export function readVBUS(device: CEEDevice): Promise<VBusReading | null> {
  return new Promise((resolve) => {
    device.controlTransfer(0xC0, 0x17, 0, 3, [], 3, (m) => {
      const data = (m as Record<string, unknown>).data as number[] | undefined;
      if (!data || data.length < 3) {
        resolve(null);
        return;
      }
      const rawV = (data[0] << 4) | (data[2] >> 4);
      const rawI = (data[1] << 4) | (data[2] & 0x0F);
      resolve({
        voltage: rawV * VBUS_V_FULLSCALE / 4096,
        currentMA: rawI * VBUS_MA_FULLSCALE / 4096,
      });
    });
  });
}
