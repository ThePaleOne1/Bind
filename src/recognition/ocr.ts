import { createWorker, type Worker } from 'tesseract.js'

let workers: Promise<Worker>[] | null = null

/** Two workers so the name and number bands are read in parallel. */
function pool(): Promise<Worker>[] {
  if (workers) return workers
  workers = [0, 1].map(() =>
    createWorker('eng', 1, {
      // Tesseract core + language data are fetched from the CDN once, then cached by the service worker
      logger: () => {},
    }).then(async (w) => {
      await w.setParameters({ preserve_interword_spaces: '1' })
      return w
    }),
  )
  return workers
}

export function warmOcr() { void pool() }

/** Crop a band from the card canvas, upscale + greyscale + contrast stretch for better OCR. */
function band(src: HTMLCanvasElement, fx: number, fy: number, fw: number, fh: number, scale = 2): HTMLCanvasElement {
  const sx = Math.round(fx * src.width), sy = Math.round(fy * src.height)
  const sw = Math.round(fw * src.width), sh = Math.round(fh * src.height)
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(sw * scale))
  c.height = Math.max(1, Math.round(sh * scale))
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height)
  const img = ctx.getImageData(0, 0, c.width, c.height)
  const d = img.data
  let lo = 255, hi = 0
  const g = new Uint8ClampedArray(d.length / 4)
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    const v = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114
    g[j] = v
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  const range = Math.max(1, hi - lo)
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    const v = ((g[j] - lo) / range) * 255
    d[i] = d[i + 1] = d[i + 2] = v
  }
  ctx.putImageData(img, 0, 0)
  return c
}

export interface OcrBands { top: string; bottom: string }

export async function readCard(card: HTMLCanvasElement): Promise<OcrBands> {
  const [w1, w2] = await Promise.all(pool())
  // Name band: top 13% of the card. Number/illustrator band: bottom 12%.
  const top = band(card, 0.03, 0.02, 0.94, 0.13)
  const bottom = band(card, 0.02, 0.86, 0.96, 0.13)
  const [r1, r2] = await Promise.all([w1.recognize(top), w2.recognize(bottom)])
  return { top: r1.data.text.replace(/\s+/g, ' ').trim(), bottom: r2.data.text.replace(/\s+/g, ' ').trim() }
}
