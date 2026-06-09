/**
 * Debug info viewer
 * Ported from debuginfo.coffee
 */

import { server, type CEEDevice } from './dataserver.js';

function hex(n: number): string {
  return n.toString(16).padStart(2, '0');
}

function update(): void {
  const body = document.body;
  body.innerHTML = '';

  const h2Server = document.createElement('h2');
  h2Server.textContent = 'Nonolith Connect';
  body.appendChild(h2Server);

  const pVersion = document.createElement('p');
  pVersion.textContent = `Version: ${server.version}`;
  body.appendChild(pVersion);

  const pPlatform = document.createElement('p');
  pPlatform.textContent = `Platform: ${navigator.userAgent}`;
  body.appendChild(pPlatform);

  const device = server.device as CEEDevice | null;
  if (device) {
    const h2Dev = document.createElement('h2');
    h2Dev.textContent = 'CEE';
    body.appendChild(h2Dev);

    for (const [label, val] of [
      ['hwVersion', device.hwVersion],
      ['fwVersion', device.fwVersion],
      ['serial', device.serial],
    ] as const) {
      const p = document.createElement('p');
      p.textContent = `${label}: ${val}`;
      body.appendChild(p);
    }

    const pEeprom = document.createElement('p');
    pEeprom.textContent = 'EEPROM data:';
    body.appendChild(pEeprom);

    const eepromStatus = document.createElement('pre');
    eepromStatus.textContent = 'loading';
    body.appendChild(eepromStatus);

    const eeprom = document.createElement('pre');
    body.appendChild(eeprom);

    device.controlTransfer(0xC0, 0xE0, 0, 0, [], 64, (m) => {
      const data = m as Record<string, unknown>;
      eepromStatus.textContent = `Status ${data.status}`;
      const bytes = data.data as number[];
      const lines: string[] = [];
      for (let i = 0; i < 8; i++) {
        const row = bytes.slice(i * 8, i * 8 + 8).map(j => hex(j)).join(' ');
        lines.push(`${hex(i * 8)}: ${row}`);
      }
      eeprom.textContent = lines.join('\n');
    });
  } else {
    const h2 = document.createElement('h2');
    h2.textContent = 'No devices found';
    body.appendChild(h2);
  }
}

function chooseDevice(): void {
  const device = server.devices.find(d => d.model === 'com.nonolithlabs.cee');
  if (device) {
    const active = server.selectDevice(device);
    active.changed.subscribe(update);
  }
  update();
}

document.addEventListener('DOMContentLoaded', () => {
  const pPlatform = document.createElement('p');
  pPlatform.textContent = `Platform: ${navigator.userAgent}`;
  document.body.appendChild(pPlatform);

  if (!window.WebSocket) {
    const p = document.createElement('p');
    p.textContent = 'Your browser does not support WebSocket';
    document.body.appendChild(p);
  } else {
    const p = document.createElement('p');
    p.textContent = 'Loading....';
    document.body.appendChild(p);
  }

  server.connect();
  server.disconnected.subscribe(() => {
    document.body.innerHTML = `
      <h1>Nonolith Connect not found</h1>
      <p>Make sure it is running or
      <a href="http://www.nonolithlabs.com/connect/">Install it</a></p>
      <p>Platform: ${navigator.userAgent}</p>`;
  });
  server.connected.subscribe(update);
  server.devicesChanged.subscribe(chooseDevice);
});
