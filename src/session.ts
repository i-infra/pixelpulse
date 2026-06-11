/**
 * Device session management
 * Ported from session_common.coffee
 * Original: (C) Nonolith Labs
 */

import {
  type Device, type CEEDevice, type BootloaderDevice,
  server, webusbSupported,
} from './dataserver.js';

const LATEST_FIRMWARE = '1.2';
const LATEST_CONNECT = '1.3';

// --- Session params interface ---

export interface SessionParams {
  app: string;
  model: string | string[];
  reset: () => void;
  updateDevsMenu: (devs: Device[]) => void;
  initDevice: (device: CEEDevice | BootloaderDevice) => void;
  deviceChanged: (device: CEEDevice | BootloaderDevice) => void;
  deviceRemoved: () => void;
  updateMessage?: string;
}

// --- Session state ---

let params: SessionParams;
let availDevs: Device[] = [];

// --- DOM helpers ---

function $(id: string): HTMLElement | null {
  return document.getElementById(id.replace(/^#/, ''));
}

function show(el: HTMLElement | null): void {
  if (el) el.style.display = '';
}

function hide(el: HTMLElement | null): void {
  if (el) el.style.display = 'none';
}

function fadeIn(el: HTMLElement | null): void {
  if (!el) return;
  el.style.display = '';
  el.style.opacity = '0';
  el.style.transition = 'opacity 300ms';
  // Force reflow then animate
  void el.offsetHeight;
  el.style.opacity = '1';
}

function hideChildren(el: HTMLElement | null): void {
  if (!el) return;
  for (const child of Array.from(el.children) as HTMLElement[]) {
    child.style.display = 'none';
  }
}

// --- Session initialization ---

export function initSession(sessionParams: SessionParams): void {
  params = sessionParams;

  if (!webusbSupported()) {
    overlay(`${params.app} requires WebUSB, which is available in Chromium-based browsers (Chrome, Edge, Brave, Opera)`);
    return;
  }

  server.connect();

  server.disconnected.subscribe(() => {
    const errorOverlay = $('error-overlay');
    hideChildren(errorOverlay);
    show($('connectError'));
    fadeIn(errorOverlay);
    params.reset();
  });

  server.devicesChanged.subscribe((devices) => {
    const models = Array.isArray(params.model) ? params.model : [params.model];
    availDevs = devices.filter(d => models.includes(d.model));
    params.updateDevsMenu(availDevs);

    if (!server.device) {
      chooseDevice();
    }
  });
}

export function chooseDevice(): void {
  if (availDevs.length === 1) {
    initDevice(availDevs[0]);
  } else if (availDevs.length > 1) {
    const errorOverlay = $('error-overlay');
    hideChildren(errorOverlay);
    show($('chooseDevices'));

    const ul = document.querySelector('#chooseDevices ul');
    if (ul) {
      ul.innerHTML = '';
      for (const d of availDevs) {
        const li = document.createElement('li');
        li.textContent = d.serial;
        li.addEventListener('click', () => initDevice(d));
        ul.appendChild(li);
      }
    }

    fadeIn(errorOverlay);
  } else {
    overlay('No devices found');
  }
}

export function parseFlags(flags: Record<string, boolean> = {}): Record<string, boolean> {
  if (navigator.userAgent.includes('Windows')) document.body.classList.add('os-windows');
  if (navigator.userAgent.includes('Linux')) document.body.classList.add('os-linux');
  if (navigator.userAgent.includes('Mac')) document.body.classList.add('os-mac');

  for (const flag of document.location.hash.slice(1).split('&')) {
    if (flag) flags[flag] = true;
  }

  return flags;
}

export function initDevice(dev: Device): void {
  if (server.device && dev.id === (server.device as CEEDevice).id) {
    overlay();
    return;
  }

  overlay('Loading Device...');

  const d = server.selectDevice(dev);

  checkUpdate(server.version, dev.fwVersion);

  d.changed.subscribe(() => {
    params.reset();
    overlay();
    params.deviceChanged(d);
  });

  d.removed.subscribe(() => {
    params.deviceRemoved();
    params.reset();
    chooseDevice();
  });

  params.initDevice(d);
}

export function overlay(message?: string): void {
  const errorOverlay = $('error-overlay');
  if (!message) {
    hide(errorOverlay);
  } else {
    hideChildren(errorOverlay);
    const status = $('error-status');
    if (status) {
      show(status);
      status.textContent = message;
    }
    fadeIn(errorOverlay);
  }
}

export function checkUpdate(connectVersion: string, fwVersion: string): void {
  const connectUpdate = LATEST_CONNECT > connectVersion;
  const fwUpdate = LATEST_FIRMWARE > fwVersion;

  const connectURL = 'http://www.nonolithlabs.com/connect/';
  const fwURL = 'http://www.nonolithlabs.com/cee/firmware';

  const notifyEl = $('update-notify');
  if (!notifyEl) return;

  if (connectUpdate || fwUpdate) {
    const plural = connectUpdate && fwUpdate;
    let msg = `<strong>Update${plural ? 's' : ''} Available!</strong> `;
    if (connectUpdate) msg += `<a href="${connectURL}" target="pp-update">Nonolith Connect ${LATEST_CONNECT}</a> `;
    if (plural) msg += 'and ';
    if (fwUpdate) msg += `<a href="${fwURL}" target="pp-update">CEE Firmware ${LATEST_FIRMWARE}</a> `;
    if (params.updateMessage) msg += ` &mdash; ${params.updateMessage}`;

    notifyEl.innerHTML = msg;

    const closeBtn = document.createElement('span');
    closeBtn.className = 'close';
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('click', () => hide(notifyEl));
    notifyEl.appendChild(closeBtn);

    show(notifyEl);
  } else {
    hide(notifyEl);
  }
}
