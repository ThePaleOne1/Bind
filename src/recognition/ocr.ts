import { logEvent } from '../utils/perfLog'
import { createWorker, PSM, type Worker } from 'tesseract.js'

let workers: Promise<Worker>[] | null = null
const CORNER_CHARS = '0123456789/ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz '
let jobs = 0                 // recognitions since the workers were (re)created
const RECYCLE_AFTER = 40     // Tesseract's wasm heap only ever grows: start fresh now and then, while idle
let recycling = false

const OUTPUT = { text: true, blocks: false, layoutBlocks: false, hocr: false, tsv: false, box: false, unlv: false, osd: false, pdf: false, imageColor: false, imageGrey: false, imageBinary: false, debug: false } as const

/**
 * Two workers: the name band and the number corner are read in parallel; the
 * wide bottom band (illustrator credit, number on old cards) is read afterwards
 * on the first worker, and only when it is needed.
 */
function pool(): Promise<Worker>[] {
  if (workers) return workers
  workers = [0, 1].map((i) =>
    createWorker('eng', 1, { logger: () => {} }).then(async (w) => {
      await w.setParameters({
        preserve_interword_spaces: '1',
        tessedit_pageseg_mode: PSM.SINGLE_BLOCK, // bands are a uniform block of 1–2 lines
        // The number corner holds digits, a slash and set codes. Japanese set codes are
        // printed in lower case ("sv3a" in a box), so lower case stays in; the number
        // itself comes from the separate digits-only line read, which is what stops
        // "004/189" coming back as "poas189".
        ...(i === 1 ? { tessedit_char_whitelist: CORNER_CHARS } : {}),
      })
      return w
    }),
  )
  return workers
}

export function warmOcr() { void pool() }

/** Number of band reads since the workers were created (debug overlay). */
export function ocrJobs() { return jobs }

/**
 * Between cards: if the workers have done a lot of work, replace them. Tesseract's
 * wasm memory never shrinks, and a worker that has grown for twenty minutes is one
 * of the ways the phone gets slower the longer a session runs.
 */
export async function recycleOcrIfNeeded(): Promise<boolean> {
  if (jobs < RECYCLE_AFTER || recycling || !workers) return false
  recycling = true
  const old = workers
  workers = null
  jobs = 0
  try {
    await Promise.all(pool())                                   // new ones ready first
    for (const p of old) p.then((w) => w.terminate()).catch(() => {})
    return true
  } finally { recycling = false }
}

/**
 * Box blur via summed-area table. Used to estimate the local background so
 * shadows and glare gradients can be divided out before OCR.
 */
function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const sat = new Float64Array((w + 1) * (h + 1))
  for (let y = 1; y <= h; y++) {
    let row = 0
    for (let x = 1; x <= w; x++) {
      row += src[(y - 1) * w + (x - 1)]
      sat[y * (w + 1) + x] = sat[(y - 1) * (w + 1) + x] + row
    }
  }
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1)
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1)
      const s = sat[y1 * (w + 1) + x1] - sat[y0 * (w + 1) + x1] - sat[y1 * (w + 1) + x0] + sat[y0 * (w + 1) + x0]
      out[y * w + x] = s / ((y1 - y0) * (x1 - x0))
    }
  }
  return out
}

/**
 * Crop a band from the card canvas and prepare it for OCR:
 *  1. resample to a fixed height (small print is enlarged, big print is not
 *     blown up needlessly: OCR time grows with pixel count),
 *  2. greyscale,
 *  3. flatten illumination: divide by a heavy local blur so a shadow across the
 *     band or a glare hot-spot becomes a flat background instead of a cliff,
 *  4. stretch contrast with percentile clipping (ignores a few blown-out pixels),
 *  5. if the band is mostly dark (full-art cards with light text), invert so
 *     Tesseract sees dark text on light.
 */
const bandCanvases = new Map<string, HTMLCanvasElement>()
function band(src: HTMLCanvasElement, fx: number, fy: number, fw: number, fh: number, targetH: number, slot = 'x', delines = false): HTMLCanvasElement {
  const sx = Math.round(fx * src.width), sy = Math.round(fy * src.height)
  const sw = Math.round(fw * src.width), sh = Math.round(fh * src.height)
  const scale = Math.min(5, Math.max(0.5, targetH / Math.max(1, sh)))
  let c = bandCanvases.get(slot)
  if (!c) { c = document.createElement('canvas'); bandCanvases.set(slot, c) }
  const w = Math.max(1, Math.round(sw * scale)), h = Math.max(1, Math.round(sh * scale))
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h }
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, w, h)
  const img = ctx.getImageData(0, 0, w, h)
  const d = img.data
  // Two greyscales: luminance, and the brightest channel. A saturated red or blue
  // background is *dark* in luminance, so black text on it loses its contrast; in
  // the brightest channel that background stays bright. Keep whichever band has
  // more contrast.
  const lum = new Float32Array(w * h), val = new Float32Array(w * h)
  let s1 = 0, q1 = 0, s2 = 0, q2 = 0
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    const r = d[i], gg = d[i + 1], b = d[i + 2]
    const l = r * 0.299 + gg * 0.587 + b * 0.114
    const v = r > gg ? (r > b ? r : b) : (gg > b ? gg : b)
    lum[j] = l; val[j] = v
    s1 += l; q1 += l * l; s2 += v; q2 += v * v
  }
  const n0 = w * h
  const g = (q1 / n0 - (s1 / n0) ** 2) >= (q2 / n0 - (s2 / n0) ** 2) ? lum : val

  // illumination flattening
  const bg = boxBlur(g, w, h, Math.max(8, Math.round(h / 3)))
  const flat = new Float32Array(w * h)
  for (let i = 0; i < g.length; i++) flat[i] = (g[i] / (bg[i] + 8)) * 160

  // percentile contrast stretch
  const hist = new Uint32Array(1024)
  for (let i = 0; i < flat.length; i++) hist[Math.min(1023, Math.max(0, flat[i] | 0))]++
  const n = flat.length
  let lo = 0, hi = 1023, acc = 0
  for (let i = 0; i < 1024; i++) { acc += hist[i]; if (acc > n * 0.02) { lo = i; break } }
  acc = 0
  for (let i = 1023; i >= 0; i--) { acc += hist[i]; if (acc > n * 0.02) { hi = i; break } }
  const range = Math.max(1, hi - lo)
  let dark = 0
  const out = new Uint8ClampedArray(w * h)
  for (let i = 0; i < flat.length; i++) {
    const v = ((flat[i] - lo) / range) * 255
    out[i] = v < 0 ? 0 : v > 255 ? 255 : v
    if (out[i] < 110) dark++
  }
  // The regulation mark and the set code sit in thin bordered boxes ("[H] [SSP EN]",
  // "[G] [sv3a]"); the box lines wreck the segmentation of what is inside them. Long
  // thin dark runs (a box edge, not a glyph stroke) are painted out, on the band as
  // Tesseract will see it (dark on light), so a mostly dark band is flipped first.
  if (delines) {
    if (dark > n * 0.55) { for (let i = 0; i < out.length; i++) out[i] = 255 - out[i] }
    const isDark = (v: number) => v < 110
    const minV = Math.max(6, Math.round(h * 0.45)), minH = Math.max(8, Math.round(w * 0.06))
    for (let x = 0; x < w; x++) {
      let run = 0
      for (let y = 0; y <= h; y++) {
        if (y < h && isDark(out[y * w + x])) { run++; continue }
        if (run >= minV) for (let k = y - run; k < y; k++) out[k * w + x] = 255
        run = 0
      }
    }
    for (let y = 0; y < h; y++) {
      let run = 0
      for (let x = 0; x <= w; x++) {
        if (x < w && isDark(out[y * w + x])) { run++; continue }
        if (run >= minH) for (let k = x - run; k < x; k++) out[y * w + k] = 255
        run = 0
      }
    }
    dark = 0   // already upright: never flip again below
  }
  const invert = dark > n * 0.55
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    const v = invert ? 255 - out[j] : out[j]
    d[i] = d[i + 1] = d[i + 2] = v
    d[i + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  return c
}

export interface OcrBands { top: string; bottom: string; corner: string }

// Regions as fractions of the card: [x, y, w, h, output height in px]
// Output heights are chosen so the smallest text in the band comes out ~25–35 px tall.
const REGIONS = {
  top: [0.03, 0.02, 0.94, 0.095, 220] as const,     // name + HP: stops above the artwork, which otherwise reads as junk lines
  bottom: [0.02, 0.85, 0.96, 0.15, 400] as const,   // illustrator credit, number (small print, any era)
  corner: [0, 0.9, 0.5, 0.1, 360] as const,         // bottom-left: number on BW → SV era
  number: [0.03, 0.915, 0.42, 0.06, 110] as const,  // just the "032/191" line on SV-era cards, read as one line of digits
}

const clean = (t: string) => t.replace(/\s+/g, ' ').trim()

/** Name band and number corner, in parallel. Enough for most modern cards. */
export async function readPrimary(card: HTMLCanvasElement): Promise<{ top: string; corner: string }> {
  const [w1, w2] = await Promise.all(pool())
  jobs += 4
  // The corner block (set code boxes, number, rarity dot) confuses the segmenter on italic
  // bold digits: "032/191" came back "5357797". A second, tight read of just the number
  // line as a single line of digits is cheap and usually clean.
  const cornerRead = async () => {
    const r2 = await w2.recognize(band(card, ...REGIONS.corner, 'corner'), {}, OUTPUT)
    // Digits only over the number line (two lines on some layouts: the illustrator credit
    // sits just above on Japanese cards, so a block, not a single line).
    await w2.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK, tessedit_char_whitelist: '0123456789/ ' })
    let line = '', codes = ''
    try {
      const nb = band(card, ...REGIONS.number, 'number', true)
      const r3 = await w2.recognize(nb, {}, { ...OUTPUT, blocks: true })
      line = clean(r3.data.text)
      // The set code sits on the same line, left of the number ("[G] [sv3a] 038/062",
      // "[H] [SSP EN] 032/191"). The number's own box from this pass says where the line
      // is, so the code is read from exactly that strip, boxes erased, at a large scale:
      // it is what tells a Japanese print from the English card with the same number.
      const words: any[] = ((r3.data as any).blocks ?? []).flatMap((b: any) => b.paragraphs.flatMap((pg: any) => pg.lines.flatMap((l: any) => l.words)))
      const num = words.find((w) => /\d{1,3}\/\d{1,3}/.test(w.text))
      if (num) {
        const [fx, fy, fw, fh] = REGIONS.number
        const sx = fx + (num.bbox.x0 / nb.width) * fw
        const y0 = fy + (num.bbox.y0 / nb.height) * fh, y1 = fy + (num.bbox.y1 / nb.height) * fh
        const ch = (y1 - y0) * 1.7, cy = Math.max(0, y0 - (ch - (y1 - y0)) / 2)
        const cw = sx - fx - 0.004
        if (cw > 0.04) {
          await w2.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE, tessedit_char_whitelist: CORNER_CHARS })
          codes = clean((await w2.recognize(band(card, fx, cy, cw, ch, 120, 'code', true), {}, OUTPUT)).data.text)
        }
      }
    } catch (e: any) { logEvent('ocr', `number line failed: ${e?.message ?? e}`); console.warn('number line read failed', e) }
    await w2.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK, tessedit_char_whitelist: CORNER_CHARS })
    return `${line} ${codes} ${clean(r2.data.text)}`.trim()
  }
  const [r1, corner] = await Promise.all([
    w1.recognize(band(card, ...REGIONS.top, 'top'), {}, OUTPUT),
    cornerRead(),
  ])
  return { top: clean(r1.data.text), corner }
}

/** Wide bottom band: illustrator credit and the number on older layouts. */
export async function readBottom(card: HTMLCanvasElement): Promise<string> {
  const [w1] = await Promise.all(pool())
  jobs += 1
  const r = await w1.recognize(band(card, ...REGIONS.bottom, 'bottom'), {}, OUTPUT)
  return clean(r.data.text)
}

/** For the debug overlay: the preprocessed bands as data URLs. */
export function debugBands(card: HTMLCanvasElement) {
  return { top: band(card, ...REGIONS.top, 'd').toDataURL(), bottom: band(card, ...REGIONS.bottom, 'd').toDataURL(), corner: band(card, ...REGIONS.corner, 'd').toDataURL(), code: band(card, ...REGIONS.number, 'd', true).toDataURL() }
}
