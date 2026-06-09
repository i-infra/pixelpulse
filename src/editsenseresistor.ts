/**
 * Edit sense resistor values
 * Ported from editsenseresistor.coffee
 */

import { server, type CEEDevice } from './dataserver.js';

interface EepromData {
  current_gain_a: number;
  current_gain_b: number;
  flags: number;
  id?: number | string;
  [key: string]: unknown;
}

let device: CEEDevice | null = null;

function update(): void {
  const section = document.querySelector('section')!;
  section.innerHTML = '';

  if (device) {
    const h1 = document.createElement('h1');
    h1.textContent = 'Edit Sense Resistor Values';
    section.appendChild(h1);

    const info = document.createElement('div');
    for (const [label, val] of [
      ['hwVersion', device.hwVersion],
      ['fwVersion', device.fwVersion],
      ['serial', device.serial],
    ] as const) {
      const p = document.createElement('p');
      p.textContent = `${label}: ${val}`;
      info.appendChild(p);
    }
    section.appendChild(info);

    section.insertAdjacentHTML('beforeend', `
      <div>
        <p>Channel A</p>
        <p><span>Currently: <output id="now_a"></output></span>&Omega;</p>
        <p><label for="res_a">Resistor value:</label> <input type="text" id="res_a" value="0.07" /></p>
      </div>
      <div>
        <p>Channel B</p>
        <p><span>Currently: <output id="now_b"></output></span>&Omega;</p>
        <p><label for="res_b">Resistor value:</label> <input type="text" id="res_b" value="0.07" /></p>
      </div>
      <div>
        <p>Power</p>
        <p><input type="checkbox" id="extpower" /> <label for="extpower">Device has cleared solder jumper and external power</label></p>
      </div>
      <nav><button class="btn primary" id="savebtn">Save to device</button></nav>
    `);

    let eeprom: EepromData | null = null;

    const read = () => {
      server.send('readCalibration', {
        id: server.createCallback((e) => {
          eeprom = e as unknown as EepromData;
          const nowA = document.getElementById('now_a');
          const nowB = document.getElementById('now_b');
          if (nowA) nowA.textContent = String(eeprom.current_gain_a / 45 / 100000);
          if (nowB) nowB.textContent = String(eeprom.current_gain_b / 45 / 100000);
          const extPower = document.getElementById('extpower') as HTMLInputElement;
          if (extPower) extPower.checked = !(eeprom.flags & 1);
        }),
      });
    };

    read();

    const write = () => {
      if (!eeprom) return;
      const resA = parseFloat((document.getElementById('res_a') as HTMLInputElement).value);
      const resB = parseFloat((document.getElementById('res_b') as HTMLInputElement).value);
      eeprom.current_gain_a = Math.round(resA * 45 * 100000);
      eeprom.current_gain_b = Math.round(resB * 45 * 100000);
      const usbpower = !(document.getElementById('extpower') as HTMLInputElement).checked;
      eeprom.flags = (eeprom.flags & ~1) | (usbpower ? 1 : 0);

      eeprom.id = server.createCallback(() => {
        alert('EEPROM written. Unplug and replug the CEE to make it take effect.');
        read();
      });

      server.send('writeCalibration', eeprom as unknown as Record<string, unknown>);
      eeprom = null;
    };

    document.getElementById('savebtn')?.addEventListener('click', write);
  } else {
    const h1 = document.createElement('h1');
    h1.textContent = 'No Devices Found';
    section.appendChild(h1);
  }
}

function chooseDevice(): void {
  device = null;
  const dev = server.devices.find(d => d.model === 'com.nonolithlabs.cee');
  if (dev) {
    device = server.selectDevice(dev) as CEEDevice;
    device.changed.subscribe(update);
    return;
  }
  update();
}

document.addEventListener('DOMContentLoaded', () => {
  const section = document.querySelector('section')!;
  const p = document.createElement('p');
  p.textContent = `Platform: ${navigator.userAgent}`;
  section.appendChild(p);

  if (!window.WebSocket) {
    const p2 = document.createElement('p');
    p2.textContent = 'Your browser does not support WebSocket';
    section.appendChild(p2);
  } else {
    const p2 = document.createElement('p');
    p2.textContent = 'Loading....';
    section.appendChild(p2);
  }

  server.connect();
  server.disconnected.subscribe(() => {
    section.innerHTML = `
      <h1>Nonolith Connect not found</h1>
      <div><p>Make sure it is running or
      <a href="http://www.nonolithlabs.com/connect/">Install it</a></p></div>`;
  });
  server.connected.subscribe(update);
  server.devicesChanged.subscribe(chooseDevice);
});
