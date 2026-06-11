/**
 * Phosphor / density rendering for LiveGraph
 *
 * Renders an oscilloscope-style intensity-graded display by accumulating
 * sample hits into a 2D histogram and mapping intensity to brightness.
 */

import type { Geom } from './livegraph.js';

// Colormap: black → color → white, 256 entries, RGBA
function buildColormap(r: number, g: number, b: number): Uint8ClampedArray {
  const map = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    const off = i * 4;
    if (t < 0.5) {
      // 0..0.5: black → full color
      const s = t * 2;
      map[off] = (r * s) | 0;
      map[off + 1] = (g * s) | 0;
      map[off + 2] = (b * s) | 0;
      map[off + 3] = s > 0.01 ? Math.min(255, (s * 320) | 0) : 0;
    } else {
      // 0.5..1: full color → white
      const s = (t - 0.5) * 2;
      map[off] = (r + (255 - r) * s) | 0;
      map[off + 1] = (g + (255 - g) * s) | 0;
      map[off + 2] = (b + (255 - b) * s) | 0;
      map[off + 3] = 255;
    }
  }
  return map;
}

// Intensity transfer curve: log compression of normalized accumulator
// values. Linear scale-to-peak makes faint traces invisible whenever any
// pixel is bright; log mapping preserves several decades of dynamic range.
const LOG_LUT_SIZE = 2048;
const LOG_COMPRESSION = 60;

function buildLogLUT(): Uint8Array {
  const lut = new Uint8Array(LOG_LUT_SIZE);
  const norm = 255 / Math.log1p(LOG_COMPRESSION);
  for (let i = 0; i < LOG_LUT_SIZE; i++) {
    lut[i] = Math.round(Math.log1p(LOG_COMPRESSION * i / (LOG_LUT_SIZE - 1)) * norm);
  }
  return lut;
}

export class PhosphorRenderer {
  canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private accum: Float32Array = new Float32Array(0);
  private imgData: ImageData | null = null;
  private colormap: Uint8ClampedArray;
  private logLUT = buildLogLUT();
  private plotW = 0;
  private plotH = 0;
  private decay = 0.92;
  private peakAccum = 1; // auto-ranging normalizer

  constructor(parent: HTMLElement, color: [number, number, number], insertBefore?: HTMLCanvasElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'phosphor-canvas';
    if (insertBefore) {
      parent.insertBefore(this.canvas, insertBefore);
    } else {
      parent.appendChild(this.canvas);
    }
    this.ctx = this.canvas.getContext('2d')!;
    this.colormap = buildColormap(color[0], color[1], color[2]);
  }

  setColor(color: [number, number, number]): void {
    this.colormap = buildColormap(color[0], color[1], color[2]);
  }

  resize(width: number, height: number, geom: Geom): void {
    this.canvas.width = width;
    this.canvas.height = height;
    this.plotW = geom.width | 0;
    this.plotH = geom.height | 0;
    if (this.plotW > 0 && this.plotH > 0) {
      this.accum = new Float32Array(this.plotW * this.plotH);
      this.imgData = this.ctx.createImageData(this.plotW, this.plotH);
    }
    this.peakAccum = 1;
  }

  // Bilinear deposit: distribute `energy` over the 4 pixels around the
  // fractional position (x, y). Subpixel positioning antialiases the trace.
  private deposit(x: number, y: number, energy: number): void {
    const w = this.plotW;
    const h = this.plotH;
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const accum = this.accum;

    if (ix >= 0 && ix < w) {
      if (iy >= 0 && iy < h) accum[iy * w + ix] += energy * (1 - fx) * (1 - fy);
      if (iy + 1 >= 0 && iy + 1 < h) accum[(iy + 1) * w + ix] += energy * (1 - fx) * fy;
    }
    if (ix + 1 >= 0 && ix + 1 < w) {
      if (iy >= 0 && iy < h) accum[iy * w + ix + 1] += energy * fx * (1 - fy);
      if (iy + 1 >= 0 && iy + 1 < h) accum[(iy + 1) * w + ix + 1] += energy * fx * fy;
    }
  }

  /**
   * Scatter sample data into the accumulation buffer, drawing line
   * segments between consecutive samples (like a real scope's beam).
   * Each segment deposits constant total energy regardless of length, so
   * fast slews are faint and dwell regions are bright — analog-style
   * intensity grading.
   * xdata/ydata are in data-space; transform coefficients convert to pixel-space.
   */
  scatter(
    xdata: Float32Array | number[],
    ydata: Float32Array | number[],
    sx: number, sy: number, dx: number, dy: number,
    geom: Geom,
  ): void {
    const w = this.plotW;
    const h = this.plotH;
    if (w <= 0 || h <= 0) return;

    const xleft = geom.xleft;
    const ytop = geom.ytop;
    const len = Math.min(xdata.length, ydata.length);
    // Bound work on pathological segments (e.g. data discontinuities)
    const maxSteps = 4 * (w + h);

    let havePrev = false;
    let px0 = 0, py0 = 0;

    for (let i = 0; i < len; i++) {
      const px = (xdata[i] * sx + dx) - xleft;
      const py = (ydata[i] * sy + dy) - ytop;

      if (isNaN(px) || isNaN(py)) {
        havePrev = false;
        continue;
      }

      if (!havePrev) {
        this.deposit(px, py, 1);
        havePrev = true;
        px0 = px;
        py0 = py;
        continue;
      }

      const segDx = px - px0;
      const segDy = py - py0;
      // Skip segments entirely outside the plot
      if ((px < 0 && px0 < 0) || (px >= w && px0 >= w)
        || (py < 0 && py0 < 0) || (py >= h && py0 >= h)) {
        px0 = px;
        py0 = py;
        continue;
      }

      let steps = Math.ceil(Math.max(Math.abs(segDx), Math.abs(segDy)));
      if (steps < 1) steps = 1;
      if (steps > maxSteps) steps = maxSteps;

      // Exclude the endpoint: it is deposited as the start of the next segment
      const energy = 1 / steps;
      const stepX = segDx / steps;
      const stepY = segDy / steps;
      let x = px0;
      let y = py0;
      for (let s = 0; s < steps; s++) {
        this.deposit(x, y, energy);
        x += stepX;
        y += stepY;
      }

      px0 = px;
      py0 = py;
    }

    // Deposit the final endpoint so the newest sample is visible
    if (havePrev) {
      this.deposit(px0, py0, 1);
    }
  }

  /**
   * Apply decay and render the accumulation buffer to the canvas.
   */
  render(geom: Geom): void {
    const w = this.plotW;
    const h = this.plotH;
    if (w <= 0 || h <= 0 || !this.imgData) return;

    const accum = this.accum;
    const pixels = this.imgData.data;
    const cmap = this.colormap;
    const decay = this.decay;

    // Find current peak for auto-ranging normalization
    let peak = 0;
    for (let i = 0; i < accum.length; i++) {
      if (accum[i] > peak) peak = accum[i];
    }
    // Smooth peak tracking to avoid flicker
    this.peakAccum = Math.max(1, this.peakAccum * 0.98, peak * 0.5);

    const lut = this.logLUT;
    const lutScale = (LOG_LUT_SIZE - 1) / this.peakAccum;

    for (let i = 0; i < accum.length; i++) {
      // Normalize, then log-compress via LUT to a 0-255 colormap index
      let li = (accum[i] * lutScale) | 0;
      if (li >= LOG_LUT_SIZE) li = LOG_LUT_SIZE - 1;
      const co = lut[li] * 4;
      const po = i * 4;
      pixels[po] = cmap[co];
      pixels[po + 1] = cmap[co + 1];
      pixels[po + 2] = cmap[co + 2];
      pixels[po + 3] = cmap[co + 3];

      // Decay
      accum[i] *= decay;
    }

    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.putImageData(this.imgData, geom.xleft, geom.ytop);
  }

  clear(): void {
    this.accum.fill(0);
    this.peakAccum = 1;
  }

  destroy(): void {
    this.canvas.remove();
  }
}
