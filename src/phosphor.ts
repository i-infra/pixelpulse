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

export class PhosphorRenderer {
  canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private accum: Float32Array = new Float32Array(0);
  private imgData: ImageData | null = null;
  private colormap: Uint8ClampedArray;
  private plotW = 0;
  private plotH = 0;
  private decay = 0.92;
  private peakAccum = 1; // auto-ranging normalizer
  dotRadius = 1; // splat radius in pixels (0=single pixel, 1=3x3, 2=5x5)

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

  /**
   * Scatter sample data into the accumulation buffer.
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

    const accum = this.accum;
    const xleft = geom.xleft;
    const ytop = geom.ytop;
    const len = Math.min(xdata.length, ydata.length);
    const r = this.dotRadius;

    for (let i = 0; i < len; i++) {
      const px = ((xdata[i] * sx + dx) - xleft) | 0;
      const py = ((ydata[i] * sy + dy) - ytop) | 0;

      // Splat a dot of radius r centered on (px, py)
      for (let oy = -r; oy <= r; oy++) {
        const iy = py + oy;
        if (iy < 0 || iy >= h) continue;
        const row = iy * w;
        for (let ox = -r; ox <= r; ox++) {
          const ix = px + ox;
          if (ix < 0 || ix >= w) continue;
          accum[row + ix] += 1;
        }
      }
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
    const scale = 255 / this.peakAccum;

    for (let i = 0; i < accum.length; i++) {
      // Map accumulator to 0-255 colormap index
      const ci = Math.min(255, (accum[i] * scale) | 0);
      const co = ci * 4;
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
