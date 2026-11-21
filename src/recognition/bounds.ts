/**
 * Where is the card, really?
 *
 * The guide box is only a hint: as a stack of cards gets shorter the top card sits
 * further from the lens and shrinks in the frame, and out of the jig nobody lines a
 * card up to the millimetre. OCR strips, foil regions and focus bands are all
 * fractions of the card, so a card that fills 90% of the box loses its number.
 *
 * The card's outer edge is a long straight line: on a small greyscale copy, count
 * for every column (row) how many rows (columns) have a strong horizontal
 * (vertical) gradient there. Long edges are candidates for the four sides; the
 * jig's walls and the art box inside the card are long edges too, so every
 * combination of candidates is scored on card shape (63:88) and edge strength, and
 * the best plausible rectangle wins. Axis-aligned only; a tilted card falls back
 * to the guide box.
 */
export interface Rect { x: number; y: number; w: number; h: number }

const DW = 128           // analysis width in px
const EDGE = 0.10        // gradient (0–1 luminance) that counts as an edge
const ASPECT = 63 / 88

const scratch = document.createElement('canvas')
const sctx = scratch.getContext('2d', { willReadFrequently: true })!

/** Up to three local maxima of edge coverage in [from, to), strongest first. */
function peaks(cov: Float32Array, from: number, to: number): { i: number; c: number }[] {
  const out: { i: number; c: number }[] = []
  for (let i = Math.max(1, from); i < Math.min(cov.length - 1, to); i++) {
    if (cov[i] >= 0.4 && cov[i] >= cov[i - 1] && cov[i] >= cov[i + 1]) {
      // merge peaks closer than 3 px, keeping the stronger
      const near = out.find((p) => Math.abs(p.i - i) <= 3)
      if (near) { if (cov[i] > near.c) { near.i = i; near.c = cov[i] } }
      else out.push({ i, c: cov[i] })
    }
  }
  return out.sort((a, b) => b.c - a.c).slice(0, 3)
}

/**
 * Find the card in `frame` (any canvas). `guide` is where the guide box sits inside
 * the frame, in frame pixels: the result must be a plausible card near it.
 */
export function findCard(frame: HTMLCanvasElement, guide: Rect): Rect | null {
  const scale = DW / frame.width
  const w = DW, h = Math.max(8, Math.round(frame.height * scale))
  if (scratch.width !== w || scratch.height !== h) { scratch.width = w; scratch.height = h }
  sctx.drawImage(frame, 0, 0, w, h)
  const d = sctx.getImageData(0, 0, w, h).data
  const l = new Float32Array(w * h)
  for (let i = 0, j = 0; i < d.length; i += 4, j++) l[j] = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 255

  const colCov = new Float32Array(w), rowCov = new Float32Array(h)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      if (Math.abs(l[i + 1] - l[i - 1]) > EDGE) colCov[x] += 1
      if (Math.abs(l[i + w] - l[i - w]) > EDGE) rowCov[y] += 1
    }
  }
  for (let x = 0; x < w; x++) colCov[x] /= h - 2
  for (let y = 0; y < h; y++) rowCov[y] /= w - 2

  const lefts = peaks(colCov, 0, Math.floor(w * 0.45))
  const rights = peaks(colCov, Math.ceil(w * 0.55), w)
  const tops = peaks(rowCov, 0, Math.floor(h * 0.45))
  const bottoms = peaks(rowCov, Math.ceil(h * 0.55), h)
  if (!lefts.length || !rights.length || !tops.length || !bottoms.length) return null

  const gw = guide.w * scale, gcx = (guide.x + guide.w / 2) * scale, gcy = (guide.y + guide.h / 2) * scale
  let best: { score: number; l: number; r: number; t: number; b: number } | null = null
  for (const L of lefts) for (const R of rights) for (const T of tops) for (const B of bottoms) {
    const cw = R.i - L.i, ch = B.i - T.i
    if (cw < gw * 0.55 || cw > gw * 1.3) continue
    const aspectErr = Math.abs(cw / Math.max(1, ch) - ASPECT) / ASPECT
    if (aspectErr > 0.1) continue
    const strength = (L.c + R.c + T.c + B.c) / 4
    const off = (Math.abs((L.i + R.i) / 2 - gcx) + Math.abs((T.i + B.i) / 2 - gcy)) / gw   // distance from the guide, in guide widths
    const score = strength - aspectErr * 2 - off * 0.3
    if (!best || score > best.score) best = { score, l: L.i, r: R.i, t: T.i, b: B.i }
  }
  if (!best) return null

  // Back to frame pixels, trimmed by half a percent so the background sliver outside
  // the printed edge stays out of the strips.
  const cw = best.r - best.l, ch = best.b - best.t
  const inset = cw * 0.005
  return {
    x: (best.l + inset) / scale,
    y: (best.t + inset) / scale,
    w: (cw - 2 * inset) / scale,
    h: (ch - 2 * inset) / scale,
  }
}
