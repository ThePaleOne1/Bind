/**
 * Reverse-holo detection.
 *
 * A reverse holo carries the foil pattern over the card *body* (margins, attack
 * area) while the artwork stays matte; a standard print has a flat body. The
 * card's outer border is matte on both, so the body texture is measured
 * relative to the border texture: the ratio is independent of exposure, noise
 * level and lens sharpness.
 *
 *   ratio ≤ FOIL_STANDARD_MAX → standard    ratio ≥ FOIL_REVERSE_MIN → reverse    between → unsure
 */
export interface FoilRead {
  ratio: number
  body: number        // margins beside the attack text (foil on a reverse; the card's own print texture on some)
  border: number      // inside the silver frame: flat on every print, the noise baseline
  art: number         // margins beside the artwork: foil on a reverse, flat ink on standard and holo prints
  edge: number        // the outer 1.8%: what the old baseline measured (crop edge noise)
  guess: 'normal' | 'reverse'
  confident: boolean
}

// Calibrated on the jig (Samsung main lens, 45° to the ceiling light), 2026-11-21:
//   standard prints read 0.18 – 0.51 (five cards), reverse holos 0.62 – 0.66 (five cards).
// Holo rares (foil artwork, foil-framed body) read 0.53 – 0.70, i.e. like a reverse: the
// body measure cannot tell a holo rare from its reverse, so those still ask.
// 2026-11-22: on full-resolution stills the ranges overlap (standard 0.28–1.10, reverse
// 0.30–8.4): the border baseline collapses to the JPEG noise floor and the card frame
// itself is textured. Until the detector is redesigned from the still crops the report
// now carries, only the extremes decide and everything else asks.
export const FOIL_STANDARD_MAX = 0.25
export const FOIL_REVERSE_MIN = 3.0

// Regions as fractions of the card [x, y, w, h]
const BODY: [number, number, number, number][] = [
  [0.025, 0.54, 0.05, 0.34],   // left body margin, below the artwork
  [0.925, 0.54, 0.05, 0.34],   // right body margin
]
// Just inside the silver frame (which spans ~0–3.5%): flat on every print, and away from
// the crop edge, which the old 0–1.8% baseline kept catching.
const BORDER: [number, number, number, number][] = [
  [0.012, 0.3, 0.016, 0.4],
  [0.972, 0.3, 0.016, 0.4],
]
// Body margins beside the artwork (between the frame and the art box): a reverse holo's
// foil runs through here; standard and holo-rare prints are flat ink here.
const ART: [number, number, number, number][] = [
  [0.04, 0.15, 0.03, 0.27],
  [0.93, 0.15, 0.03, 0.27],
]
const EDGE: [number, number, number, number][] = [
  [0.0, 0.3, 0.018, 0.4],
  [0.982, 0.3, 0.018, 0.4],
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
  const art = ART.reduce((a, r) => a + texture(card, ...r), 0) / ART.length
  const edge = EDGE.reduce((a, r) => a + texture(card, ...r), 0) / EDGE.length
  const ratio = art / Math.max(1e-4, border)
  const guess = Number.isFinite(FOIL_REVERSE_MIN) && ratio >= (FOIL_STANDARD_MAX + FOIL_REVERSE_MIN) / 2 ? 'reverse' : 'normal'
  const confident = ratio <= FOIL_STANDARD_MAX || ratio >= FOIL_REVERSE_MIN
  return { ratio, body, border, art, edge, guess, confident }
}
