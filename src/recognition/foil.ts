/**
 * Reverse-holo detection.
 *
 * A reverse holo carries the foil pattern over the card *body* (margins, attack
 * area) while the artwork stays matte; a standard print has a flat body. The
 * card's outer border is matte on both, so the body texture is measured
 * relative to the border texture: the ratio is independent of exposure, noise
 * level and lens sharpness.
 *
 *   ratio ≲ 1.5  → standard        ratio ≳ 2.2  → reverse        between → unsure
 */
export interface FoilRead { ratio: number; body: number; border: number; guess: 'normal' | 'reverse'; confident: boolean }

// Uncalibrated: until real-camera readings for known standard and reverse cards are
// in, the read is never "confident" and the app asks, showing the ratio for calibration.
export const FOIL_STANDARD_MAX = -1
export const FOIL_REVERSE_MIN = Infinity

// Regions as fractions of the card [x, y, w, h]
const BODY: [number, number, number, number][] = [
  [0.025, 0.54, 0.05, 0.34],   // left body margin, below the artwork
  [0.925, 0.54, 0.05, 0.34],   // right body margin
]
const BORDER: [number, number, number, number][] = [
  [0.0, 0.3, 0.018, 0.4],      // left outer border
  [0.982, 0.3, 0.018, 0.4],    // right outer border
]

const scratch = document.createElement('canvas')
const sctx = scratch.getContext('2d', { willReadFrequently: true })!

/** High-frequency luminance energy of a region, normalised by its brightness. */
function texture(card: HTMLCanvasElement, fx: number, fy: number, fw: number, fh: number): number {
  const sx = Math.round(fx * card.width), sy = Math.round(fy * card.height)
  const sw = Math.max(4, Math.round(fw * card.width)), sh = Math.max(4, Math.round(fh * card.height))
  const scale = Math.min(1, 320 / sh)
  const w = Math.max(4, Math.round(sw * scale)), h = Math.max(4, Math.round(sh * scale))
  scratch.width = w; scratch.height = h
  sctx.drawImage(card, sx, sy, sw, sh, 0, 0, w, h)
  const d = sctx.getImageData(0, 0, w, h).data
  const g = new Float32Array(w * h)
  let mean = 0
  for (let i = 0, j = 0; i < d.length; i += 4, j++) { g[j] = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114; mean += g[j] }
  mean /= g.length
  // high-pass: pixel minus a 5x5 box mean
  let s2 = 0, n = 0
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      let m = 0
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) m += g[(y + dy) * w + (x + dx)]
      const hp = g[y * w + x] - m / 25
      s2 += hp * hp; n++
    }
  }
  return Math.sqrt(s2 / Math.max(1, n)) / Math.max(8, mean)
}

export function readFoil(card: HTMLCanvasElement): FoilRead {
  const body = BODY.reduce((a, r) => a + texture(card, ...r), 0) / BODY.length
  const border = BORDER.reduce((a, r) => a + texture(card, ...r), 0) / BORDER.length
  const ratio = body / Math.max(1e-4, border)
  const guess = Number.isFinite(FOIL_REVERSE_MIN) && ratio >= (FOIL_STANDARD_MAX + FOIL_REVERSE_MIN) / 2 ? 'reverse' : 'normal'
  const confident = ratio <= FOIL_STANDARD_MAX || ratio >= FOIL_REVERSE_MIN
  return { ratio, body, border, guess, confident }
}
