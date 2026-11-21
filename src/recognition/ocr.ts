import { createWorker, PSM, type Worker } from 'tesseract.js'

let workers: Promise<Worker>[] | null = null

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
        tessedit_do_invert: '0',                 // we already choose the polarity; skip the inverted second pass
        // The number corner only ever holds digits, a slash and set-code capitals
        // (TG12/TG30, SV001/SV122): restricting the alphabet stops "004/189"
        // coming back as "poas189".
        ...(i === 1 ? { tessedit_char_whitelist: '0123456789/ABCDEFGHIJKLMNOPQRSTUVWXYZ ' } : {}),
      })
      return w
    }),
  )
  return workers
}

export function warmOcr() { void pool() }

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
function band(src: HTMLCanvasElement, fx: number, fy: number, fw: number, fh: number, targetH: number): HTMLCanvasElement {
  const sx = Math.round(fx * src.width), sy = Math.round(fy * src.height)
  const sw = Math.round(fw * src.width), sh = Math.round(fh * src.height)
  const scale = Math.min(5, Math.max(0.5, targetH / Math.max(1, sh)))
  const c = document.createElement('canvas')
  const w = (c.width = Math.max(1, Math.round(sw * scale)))
  const h = (c.height = Math.max(1, Math.round(sh * scale)))
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, w, h)
  const img = ctx.getImageData(0, 0, w, h)
  const d = img.data
  const g = new Float32Array(w * h)
  for (let i = 0, j = 0; i < d.length; i += 4, j++) g[j] = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114

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
  top: [0.03, 0.015, 0.94, 0.14, 150] as const,     // name + HP (large print)
  bottom: [0.02, 0.85, 0.96, 0.15, 400] as const,   // illustrator credit, number (small print, any era)
  corner: [0, 0.9, 0.5, 0.1, 360] as const,         // bottom-left: number on BW → SV era
}

const clean = (t: string) => t.replace(/\s+/g, ' ').trim()

/** Name band and number corner, in parallel. Enough for most modern cards. */
export async function readPrimary(card: HTMLCanvasElement): Promise<{ top: string; corner: string }> {
  const [w1, w2] = await Promise.all(pool())
  const [r1, r2] = await Promise.all([
    w1.recognize(band(card, ...REGIONS.top), {}, OUTPUT),
    w2.recognize(band(card, ...REGIONS.corner), {}, OUTPUT),
  ])
  return { top: clean(r1.data.text), corner: clean(r2.data.text) }
}

/** Wide bottom band: illustrator credit and the number on older layouts. */
export async function readBottom(card: HTMLCanvasElement): Promise<string> {
  const [w1] = await Promise.all(pool())
  const r = await w1.recognize(band(card, ...REGIONS.bottom), {}, OUTPUT)
  return clean(r.data.text)
}

/** For the debug overlay: the preprocessed bands as data URLs. */
export function debugBands(card: HTMLCanvasElement) {
  return { top: band(card, ...REGIONS.top).toDataURL(), bottom: band(card, ...REGIONS.bottom).toDataURL(), corner: band(card, ...REGIONS.corner).toDataURL() }
}
