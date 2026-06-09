/**
 * Pixelpulse UI elements
 * Ported from views.coffee
 * Original: (C) 2011 Nonolith Labs, Kevin Mehall <km@kevinmehall.net>
 * Distributed under the terms of the GNU GPLv3
 */

import {
  type CEEDevice, type Channel, type Stream, type OutputSource, type UpdateMessage,
  Listener, DataListener, server,
} from './dataserver.js';
import { AXIS_SPACING } from './livegraph.js';
import { unitPrefixScale } from './human-units.js';
import {
  TimeseriesGraphListener, TimeseriesGraph, XYGraphView,
  type StreamSelectElement,
} from './livegraph-data-listener.js';
import { numberWidget, selectDropdown, btnPopup, type NumberWidget } from './widgets.js';
import { downloadCSV } from './export.js';
import { TypedEvent } from './dataserver.js';

// --- Colors ---

const COLORS: [number, number, number][][] = [
  [[0x32, 0x00, 0xC7], [0x0, 0x32, 0xC7]],
  [[0x0, 0x7C, 0x16], [0x6f, 0xC7, 0x00]],
];

const GAIN_OPTIONS = [1, 2, 4, 8, 16, 32, 64];

// --- Pixelpulse state (module-level) ---

export const captureState = new TypedEvent<[string]>();
export const layoutChanged = new TypedEvent();
export const triggeringChanged = new TypedEvent<[boolean]>();

export let timeseries: TimeseriesGraphListener;
export let meterListener: Listener;
export let streams: Stream[] = [];
export let channelviews: ChannelView[] = [];
// timeseriesGraphs tracked via timeseries.graphs
let sidegraph1: XYGraphView;
let sidegraph2: XYGraphView;
let hidePopupFn: (() => void) | null = null;

// --- Init view ---

export function initView(dev: CEEDevice): void {
  channelviews = [];
  streams = [];

  for (const channel of Object.values(dev.channels)) {
    for (const stream of Object.values(channel.streams)) {
      streams.push(stream);
    }
  }

  meterListener = new Listener(dev, streams);
  meterListener.configure();

  timeseries = new TimeseriesGraphListener(dev, streams);
  timeseries.queueWindowUpdate();

  let i = 0;
  const streamsEl = document.getElementById('streams')!;
  for (const channel of Object.values(dev.channels)) {
    const cv = new ChannelView(channel, i++);
    channelviews.push(cv);
    streamsEl.appendChild(cv.el);
  }

  sidegraph1 = new XYGraphView(
    document.getElementById('sidegraph1')!,
    timeseries, makeStreamSelect, layoutChanged,
  );
  sidegraph2 = new XYGraphView(
    document.getElementById('sidegraph2')!,
    timeseries, makeStreamSelect, layoutChanged,
  );

  // Show x-axis ticks on the last stream
  const lastGraph = timeseries.graphs[timeseries.graphs.length - 1];
  lastGraph.showXbottom = true;
  lastGraph.div.style.marginBottom = `${-AXIS_SPACING + 5}px`;
  const aside = lastGraph.div.parentElement?.querySelector('aside') as HTMLElement | null;
  if (aside) aside.style.marginBottom = `${-AXIS_SPACING + 5}px`;
  lastGraph.resized();

  meterListener.submit();
}

export function toggleTrigger(): void {
  const triggering = !timeseries.isTriggerEnabled();
  document.body.classList.toggle('triggering', triggering);

  timeseries.cancelAllActions();

  if (triggering) {
    timeseries.enableTrigger();
  } else {
    timeseries.disableTrigger();
  }

  timeseries.updateWindow();
  triggeringChanged.notify(triggering);
}

export function autozoom(): void {
  timeseries.autozoom();
}

captureState.subscribe(() => {
  if (!timeseries?.canChangeView()) {
    timeseries.zoomCompletelyOut(false);
  }
});

export function destroyView(): void {
  document.querySelectorAll('#streams section.channel').forEach(el => el.remove());
  document.querySelectorAll('#sidegraphs > section').forEach(el => { el.innerHTML = ''; });
  meterListener?.cancel();
  timeseries?.cancel();
  for (const cv of channelviews) cv.destroy();
  setLayout(0);
}

// --- ChannelView ---

class ChannelView {
  el: HTMLElement;
  private section: HTMLElement;
  private streamViews: StreamView[] = [];

  constructor(public channel: Channel, public index: number) {
    this.section = document.createElement('section');
    this.section.className = 'channel';
    this.el = this.section;

    const header = document.createElement('header');
    this.section.appendChild(header);

    const aside = document.createElement('aside');
    header.appendChild(aside);

    const h1 = document.createElement('h1');
    h1.textContent = channel.displayName;
    aside.appendChild(h1);

    let i = 0;
    for (const s of Object.values(channel.streams)) {
      const sv = new StreamView(this, s, i++);
      this.streamViews.push(sv);
      this.section.appendChild(sv.el);
    }

    meterListener.updated.subscribe(this.onValues);
  }

  destroy(): void {
    for (const sv of this.streamViews) sv.destroy();
  }

  private onValues = (m: UpdateMessage): void => {
    const source = this.channel.source;
    if (source.source !== 'constant') return;

    let sourceStream: Stream | undefined;
    let measureStream: Stream | undefined;

    for (const s of Object.values(this.channel.streams)) {
      // eslint-disable-next-line eqeqeq -- server may send mode as number or string
      if (s.outputMode == source.mode) {
        sourceStream = s;
      } else {
        measureStream = s;
      }
    }

    if (!sourceStream || !measureStream) return;

    const srcArr = m.data[meterListener.streamIndex(sourceStream)];
    const sourceValue = srcArr[srcArr.length - 1];

    const measArr = m.data[meterListener.streamIndex(measureStream)];
    const measureValue = measArr[measArr.length - 1];

    const sourceChannelIsOff = Math.abs(sourceValue - (source.value ?? 0)) > sourceStream.uncertainty * 5;
    const measureChannelIsHiRail = Math.abs(measureValue - measureStream.max) < measureStream.uncertainty * 5;
    const measureChannelIsLoRail = Math.abs(measureValue - measureStream.min) < measureStream.uncertainty * 5;

    const isLimited = sourceChannelIsOff && (measureChannelIsHiRail || measureChannelIsLoRail);
    this.section.classList.toggle('limited', isLimited);
  };
}

// --- StreamView ---

class StreamView {
  el: HTMLElement;
  lg: TimeseriesGraph;

  private valueEl: HTMLSpanElement;
  private unitSpan: HTMLSpanElement;
  private sourceHead: HTMLHeadingElement;
  private sourceEl: HTMLDivElement;
  private sourceModeSel: ReturnType<typeof selectDropdown>;
  private sourceTypeSel: ReturnType<typeof selectDropdown>;
  private gainOpts: HTMLSelectElement | null = null;
  private sourceInputs: NumberWidget[] = [];
  private sourceType: string | null = null;
  private lastSourceMode: string | number | null = null;
  private lastValue = 0;
  private valueUnitScale = 1;
  private valueDigits = 0;

  constructor(
    public channelView: ChannelView,
    public stream: Stream,
    public index: number,
  ) {
    const section = document.createElement('section');
    section.className = 'stream';
    this.el = section;

    const aside = document.createElement('aside');
    section.appendChild(aside);

    const h1 = document.createElement('h1');
    h1.textContent = stream.displayName;
    aside.appendChild(h1);

    const timeseriesDiv = document.createElement('div');
    timeseriesDiv.className = 'livegraph';
    section.appendChild(timeseriesDiv);

    // Reading UI
    const reading = document.createElement('span');
    reading.className = 'reading';
    this.valueEl = document.createElement('span');
    this.valueEl.className = 'value';
    this.unitSpan = document.createElement('span');
    this.unitSpan.className = 'unit';
    reading.appendChild(this.valueEl);
    reading.appendChild(this.unitSpan);
    aside.appendChild(reading);

    const color = COLORS[channelView.index][index];
    this.lg = timeseries.makeGraph(stream, timeseriesDiv, color);

    // Meter listener
    meterListener.updated.subscribe((m: UpdateMessage) => {
      const idx = meterListener.streamIndex(stream);
      const arr = m.data[idx];
      this.onValue(arr[arr.length - 1]);
    });

    // Source controls
    this.sourceHead = document.createElement('h2');
    aside.appendChild(this.sourceHead);

    const modeOpts = ['Source', 'Measure'];
    if (stream.id === 'i') modeOpts.push('Disable');

    this.sourceModeSel = selectDropdown({
      options: modeOpts,
      showText: true,
      changed: (o) => {
        let m: string | number;
        switch (o) {
          case 'Disable': m = 0; break;
          case 'Source': m = stream.outputMode; break;
          case 'Measure':
            m = stream.id === 'v' ? 2 : stream.id === 'i' ? 1 : 0;
            break;
          default: m = 0;
        }
        stream.parent.setConstant(m, 0);
      },
    });
    this.sourceHead.appendChild(this.sourceModeSel.el);

    this.sourceTypeSel = selectDropdown({
      options: ['Constant', 'Square', 'Sine', 'Triangle'],
      showText: false,
      changed: (o) => {
        let src = o.toLowerCase();
        if (src === 'square' && (server.device as CEEDevice).hasAdvSquare) {
          src = 'adv_square';
        }
        stream.parent.guessSourceOptions(src);
      },
    });
    this.sourceHead.appendChild(this.sourceTypeSel.el);

    this.sourceEl = document.createElement('div');
    this.sourceEl.className = 'source';
    aside.appendChild(this.sourceEl);

    stream.parent.outputChanged.subscribe(this.sourceChanged);
    if (stream.parent.source) {
      this.sourceChanged(stream.parent.source);
    }

    // Gain selector
    if (stream.id === 'v') {
      this.gainOpts = document.createElement('select');
      this.gainOpts.className = 'gainopts';
      aside.appendChild(this.gainOpts);
      this.gainOpts.addEventListener('change', () => {
        stream.setGain(parseInt(this.gainOpts!.value));
      });

      for (const g of GAIN_OPTIONS) {
        const opt = document.createElement('option');
        opt.value = String(g);
        opt.innerHTML = `${g}&times;`;
        this.gainOpts.appendChild(opt);
      }
    }

    stream.gainChanged.subscribe(this.gainChanged);
    this.gainChanged(stream.gain);
  }

  private onValue(val: number): void {
    const v = val / this.valueUnitScale;

    if (!isNaN(v)) {
      this.valueEl.textContent = v.toFixed(this.valueDigits);
    } else {
      this.valueEl.textContent = '- - - ';
    }

    this.valueEl.classList.toggle('negative', v < 0);
    this.lastValue = val;
  }

  private sourceChanged = (m: OutputSource): void => {
    // eslint-disable-next-line eqeqeq -- server may send mode as number or string
    const isSource = m.mode == this.stream.outputMode;

    if (m.mode !== this.lastSourceMode) {
      this.lastSourceMode = m.mode;
      this.sourceHead.classList.toggle('isDriving', isSource);

      let opt: string;
      // eslint-disable-next-line eqeqeq
      if (this.stream.id === 'i' && m.mode == 0) {
        opt = 'Disable';
      } else {
        opt = isSource ? 'Source' : 'Measure';
      }
      this.sourceModeSel.select(opt);

      // Hide sourceType if not source
      this.sourceTypeSel.el.style.display = isSource ? '' : 'none';
    }

    this.lg.sourceChanged(isSource, m);

    if (isSource) {
      if (m.source !== this.sourceType) {
        this.sourceType = m.source;
        this.sourceTypeSel.select(
          this.sourceType === 'adv_square' ? 'Square' : capitalize(this.sourceType),
        );

        this.sourceInputs = [];
        this.sourceEl.innerHTML = '';

        const stream = this.stream;
        const channel = stream.parent;
        const dev = server.device as CEEDevice;

        const propInput = (filter: ReturnType<typeof valFilter>, title: string, cssClass: string): NumberWidget => {
          const w = numberWidget(filter, title, cssClass);
          this.sourceInputs.push(w);
          this.sourceEl.appendChild(w.el);
          return w;
        };

        const valFilter = (prop: string) => ({
          changedfn: (v: number) => channel.setAdjust(prop, v),
          valuefn: (m: unknown) => (m as Record<string, number>)[prop],
          min: stream.min,
          max: stream.max,
          step: Math.pow(10, -stream.digits),
          unit: stream.units,
          digits: stream.digits,
        });

        const freqFilter = {
          changedfn: (v: number) => {
            channel.setAdjust('period', 1 / (v * dev.sampleTime));
          },
          valuefn: (m: unknown) => 1 / ((m as Record<string, number>).period * dev.sampleTime),
          min: 0.1,
          max: 1 / dev.sampleTime / 5,
          step: 1,
          unit: 'Hz',
          digits: 1,
        };

        const freqFilterSquare = {
          ...freqFilter,
          changedfn: (v: number) => {
            const period = 1 / (v * dev.sampleTime);
            const { dutyCycleHint = 0.5 } = stream.parent.source;
            const t1 = period * dutyCycleHint;
            channel.setAdjust({
              highSamples: Math.round(t1),
              lowSamples: Math.round(period - t1),
              dutyCycleHint,
            });
          },
          valuefn: (m: unknown) => {
            const rec = m as Record<string, number>;
            return 1 / ((rec.highSamples + rec.lowSamples) * dev.sampleTime);
          },
        };

        const dutyCycleFilter = {
          changedfn: (v: number) => {
            v = Math.max(0, Math.min(100, v / 100));
            const { highSamples = 0, lowSamples = 0 } = stream.parent.source;
            const per = highSamples + lowSamples;
            channel.setAdjust({
              highSamples: Math.ceil(v * per),
              lowSamples: Math.floor((1 - v) * per),
              dutyCycleHint: v,
            });
          },
          valuefn: (m: unknown) => {
            const rec = m as Record<string, number>;
            return rec.highSamples / (rec.highSamples + rec.lowSamples) * 100;
          },
          min: 0,
          max: 100,
          step: 1,
          unit: '%',
          digits: 1,
        };

        switch (m.source) {
          case 'constant':
            propInput(valFilter('value'), 'Value', 'inp-value');
            break;
          case 'adv_square':
            propInput(valFilter('low'), 'Value 1', 'inp-value1');
            propInput(valFilter('high'), 'Value 2', 'inp-value2');
            propInput(freqFilterSquare, 'Frequency', 'inp-freq');
            propInput(dutyCycleFilter, 'Duty Cycle', 'inp-duty');
            break;
          case 'sine': case 'triangle': case 'square':
            propInput(valFilter('offset'), 'Center Value', 'inp-value');
            propInput(valFilter('amplitude'), 'Amplitude', 'inp-amplitude');
            propInput(freqFilter, 'Frequency', 'inp-frequency');
            break;
        }
      }

      for (const inp of this.sourceInputs) {
        inp.set(m);
      }
    } else {
      this.sourceEl.innerHTML = '';
      this.sourceType = null;
    }
  };

  private gainChanged = (g: number): void => {
    if (this.gainOpts) this.gainOpts.value = String(g);
    this.lg.gainChanged(g);

    const prescale = this.lg.yaxis.prescale ?? 1;
    const [unitPrefix, unitScale] = unitPrefixScale(this.lg.yaxis.span() / 2 / prescale);
    this.unitSpan.textContent = unitPrefix + this.lg.yaxis.unit;
    this.valueUnitScale = unitScale * prescale;
    this.valueDigits = this.stream.digits + Math.floor(Math.log(this.valueUnitScale) / Math.LN10);
    this.onValue(this.lastValue);
  };

  destroy(): void {
    // Cleanup if needed
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// --- Layout ---

export function setLayout(l: number): void {
  document.body.classList.remove('layout-0side', 'layout-1side', 'layout-2side');
  document.body.classList.add(`layout-${l}side`);

  if (sidegraph1 && sidegraph2) {
    if (l >= 1) {
      sidegraph1.configure(streams[0], streams[1]);
    } else {
      sidegraph1.hidden();
    }

    if (l >= 2) {
      sidegraph2.configure(streams[2], streams[3]);
    } else {
      sidegraph2.hidden();
    }
  }

  layoutChanged.notify();
}

layoutChanged.subscribe(() => {
  timeseries?.redrawAll();
});

// --- Stream select factory ---

export function makeStreamSelect(): StreamSelectElement {
  const sel = document.createElement('select') as StreamSelectElement;
  for (let i = 0; i < streams.length; i++) {
    const s = streams[i];
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = `${s.displayName} (${s.units})`;
    sel.appendChild(opt);
  }

  sel.selectStream = (stream: Stream) => {
    sel.value = String(streams.indexOf(stream));
  };

  sel.stream = () => streams[parseInt(sel.value)];

  return sel;
}

// --- Document ready setup ---

export function setupToolbar(): void {
  // Config popup
  const configBtn = document.getElementById('device-config');
  const configPopup = document.getElementById('config-popup');
  if (configBtn && configPopup) {
    btnPopup(configBtn, configPopup, () => {
      const dev = server.device as CEEDevice;
      const rateSelect = document.getElementById('config-sample-rate') as HTMLSelectElement;
      for (const opt of Array.from(rateSelect.options)) {
        opt.style.display = parseFloat(opt.value) >= dev.minSampleTime ? '' : 'none';
      }
      rateSelect.value = String(dev.sampleTime);
    });
  }

  // Apply config
  document.getElementById('device-config-apply')?.addEventListener('click', () => {
    hidePopupFn?.();
    const rate = parseFloat(
      (document.getElementById('config-sample-rate') as HTMLSelectElement).value,
    );
    (server.device as CEEDevice).configure({ sampleTime: rate });
  });

  // Export CSV
  document.getElementById('download-btn')?.addEventListener('click', () => {
    const dev = server.device as CEEDevice;
    dev.pauseCapture();
    const len = timeseries.doneSamples;
    const maxCount = 40000;

    const allStreams: Stream[] = [];
    for (const channel of Object.values(dev.channels)) {
      for (const stream of Object.values(channel.streams)) {
        allStreams.push(stream);
      }
    }

    const df = Math.max(Math.round(len / maxCount), 1);
    const listener = new DataListener(dev, allStreams);
    listener.configure(0, len * dev.sampleTime, Math.floor(len / df));
    listener.submit();

    listener.done.subscribe(() => {
      const cols = allStreams.map((stream, i) => ({
        name: stream.displayName,
        units: stream.units,
        precision: 4,
        data: Array.from(listener.data[i]),
      }));

      cols.unshift({
        name: 'Time',
        units: 's',
        precision: 7,
        data: Array.from(listener.xdata).map((_, i) => i * dev.sampleTime * df),
      });

      downloadCSV(cols);
    });
  });

  // Window resize
  window.addEventListener('resize', () => layoutChanged.notify());

  // Start/pause
  document.getElementById('startpause')?.addEventListener('click', () => {
    const dev = server.device as CEEDevice;
    if (dev.captureState) {
      dev.pauseCapture();
    } else {
      dev.startCapture();
    }
  });

  captureState.subscribe((s) => {
    const btn = document.getElementById('startpause');
    if (btn) btn.title = s ? 'Pause' : 'Start';
    document.body.classList.toggle('capturing', !!s);
  });
}
