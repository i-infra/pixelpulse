/** SI prefix and scale factor for a value */
export function unitPrefixScale(v: number): [string, number] {
  if (v === 0) return ['', 1];
  v = Math.abs(v);
  let m = Math.floor(Math.log(v) / Math.LN10);
  m = Math.floor(m / 3) * 3;

  const unit: Record<number, string> = {
    12: 'T', 9: 'G', 6: 'M', 3: 'k', 0: '',
    '-3': 'm', '-6': '\u00B5', '-9': 'n', '-12': 'p',
  };

  return [unit[m] ?? '', Math.pow(10, m)];
}

/** Generate an array from lo to hi (inclusive) with given step */
export function arange(lo: number, hi: number, step: number): number[] {
  const ret = new Array(Math.ceil((hi - lo) / step + 1));
  for (let i = 0; i < ret.length; i++) {
    ret[i] = lo + i * step;
  }
  return ret;
}

/**
 * Generate a grid for the specified range.
 * min, max: bounds of the window
 * countHint: approximate number of ticks
 * limitMin, limitMax: clip generated ticks to these bounds
 */
export function grid(
  min: number, max: number, countHint = 10,
  limitMin = -Infinity, limitMax = Infinity,
): number[] {
  const span = max - min;
  let step = Math.pow(10, Math.floor(Math.log(span / countHint) / Math.LN10));

  const err = countHint / span * step;
  if (err <= 0.15) step *= 10;
  else if (err <= 0.35) step *= 5;
  else if (err <= 0.75) step *= 2;

  const gridMin = Math.ceil(Math.max(min, limitMin) / step) * step;
  const gridMax = Math.floor(Math.min(max, limitMax) / step) * step;

  return arange(gridMin, gridMax, step);
}

const UNICODE_SUPERSCRIPT = String.fromCharCode(
  8304, 185, 178, 179, 8308, 8309, 8310, 8311, 8312, 8313,
);

/** Generate a logarithmic grid with labels */
export function logGridLabels(
  powMin: number, powMax: number, unit?: string,
): [number, string][] {
  const out: [number, string][] = [];

  for (let i = powMin; i <= powMax; i++) {
    for (let j = 1; j <= 9; j++) {
      if (j === 1) {
        out.push([i, `10${UNICODE_SUPERSCRIPT[i]}`]);
      } else {
        out.push([i + Math.log(j) / Math.LN10, '']);
      }
    }
  }

  if (unit && out.length > 0) {
    out[0][1] += ` ${unit}`;
  }

  return out;
}

/**
 * Generate a grid with labels for the specified range.
 * unit: base unit string (e.g. 'V', 'A')
 */
export function gridLabels(
  min: number, max: number, unit = '', countHint = 10,
  useScale = true, limitMin?: number, limitMax?: number, prescale = 1,
): [number, string][] {
  const [unitprefix, rawScale] = useScale
    ? unitPrefixScale((max - min) / 2 / prescale)
    : ['', 1];
  const scale = rawScale * prescale;
  const g = grid(min, max, countHint, limitMin, limitMax);
  const digits = Math.max(
    Math.ceil(-Math.log(Math.abs((g[1] - g[0]) / scale)) / Math.LN10), 0,
  );
  const hasZero = g.includes(0);

  return g.map((v, i) => {
    const num = (v / scale).toFixed(digits);
    const hasunit = hasZero ? v === 0 : i === 0;
    const showunit = unit && hasunit ? `${unitprefix}${unit}` : '';
    return [v, `${num}${showunit}`];
  });
}
