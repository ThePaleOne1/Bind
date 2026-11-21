import { loadIndex, getCard } from '../api/tcgdex'
import type { CardRecord } from '../data/types'
import { readCard, debugBands } from './ocr'
import { matchCards, parseOcr, type Candidate, type Parsed } from './matcher'
import { similarity } from '../utils/text'
import type { Roi } from './frameAnalyzer'
import { sharpnessOf } from './focus'

export interface Recognition {
  card: CardRecord | null
  confidence: number
  alternatives: Candidate[]
  parsed: Parsed
  ocr: { top: string; bottom: string; corner: string }
  ms: number
  sharpness: number
  bands?: { top: string; bottom: string; corner: string } // preprocessed band images (debug)
}

/** Grab the guide region of the live video at full camera resolution. */
export function captureRoi(video: HTMLVideoElement, roi: Roi): HTMLCanvasElement {
  const vw = video.videoWidth, vh = video.videoHeight
  const c = document.createElement('canvas')
  c.width = Math.round(roi.w * vw)
  c.height = Math.round(roi.h * vh)
  c.getContext('2d')!.drawImage(video, roi.x * vw, roi.y * vh, c.width, c.height, 0, 0, c.width, c.height)
  return c
}

export async function setNameOf(setId: string): Promise<string> {
  const idx = await loadIndex()
  return idx.sets[setId]?.name ?? setId.toUpperCase()
}

/** Standard deviation of brightness over the card region (0–1). A printed card is busy; a bare jig or table is flat. */
export function contrastOf(card: HTMLCanvasElement): number {
  const c = document.createElement('canvas')
  c.width = 48; c.height = 64
  const x = c.getContext('2d', { willReadFrequently: true })!
  x.drawImage(card, 0, 0, 48, 64)
  const d = x.getImageData(0, 0, 48, 64).data
  let s = 0, s2 = 0
  const n = d.length / 4
  for (let i = 0; i < d.length; i += 4) { const v = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 255; s += v; s2 += v * v }
  const m = s / n
  return Math.sqrt(Math.max(0, s2 / n - m * m))
}
export const MIN_CONTRAST = 0.06

const EMPTY: Omit<Recognition, 'ms' | 'sharpness'> = {
  card: null, confidence: 0, alternatives: [],
  parsed: { number: null, total: null, numberWeak: false, numberAlts: [], nameGuess: '', illustratorGuess: null },
  ocr: { top: '', bottom: '', corner: '' },
}

export async function recognize(card: HTMLCanvasElement, opts: { debug?: boolean } = {}): Promise<Recognition> {
  const t0 = performance.now()
  // Nothing printed in the frame (empty jig, table): skip the OCR, which is slow on noise.
  if (contrastOf(card) < MIN_CONTRAST) {
    const out: Recognition = { ...EMPTY, ms: performance.now() - t0, sharpness: 0 }
    if (opts.debug) out.bands = debugBands(card)
    return out
  }
  const [index, ocr] = await Promise.all([loadIndex(), readCard(card)])
  const parsed = parseOcr(ocr)
  const m = matchCards(parsed, index)
  let best = m.best
  let confidence = m.confidence

  // Disambiguate same-number / same-name cards using the illustrator credit
  const close = m.alternatives.filter((a) => best && a.score >= best.score - 0.12).slice(0, 6)
  if (best && close.length > 1 && parsed.illustratorGuess) {
    const details = await Promise.all(close.map((c) => getCard(c.entry.id).catch(() => null)))
    let top: { c: Candidate; s: number } | null = null
    details.forEach((d, i) => {
      if (!d?.illustrator) return
      const s = similarity(parsed.illustratorGuess!, d.illustrator)
      if (!top || s > top.s) top = { c: close[i], s }
    })
    if (top && (top as any).s > 0.6) {
      best = (top as any).c
      confidence = Math.max(confidence, 0.8)
    }
  }

  let cardRec: CardRecord | null = null
  if (best && confidence >= 0.5) {
    cardRec = await getCard(best.entry.id).catch(() => null)
  }
  const out: Recognition = { card: cardRec, confidence, alternatives: m.alternatives, parsed, ocr, ms: performance.now() - t0, sharpness: sharpnessOf(card) }
  if (opts.debug) out.bands = debugBands(card)
  return out
}

/** True when the OCR found essentially nothing: an empty jig, a hand, the table. */
export function isBlank(r: Recognition): boolean {
  return !r.parsed.number && r.alternatives.length === 0
}

/** Prefer the attempt that read a collector number; otherwise the more confident one. */
export function betterOf(a: Recognition, b: Recognition): Recognition {
  if (a.card && !b.card) return a
  if (b.card && !a.card) return b
  if (a.parsed.number && !b.parsed.number) return a
  if (b.parsed.number && !a.parsed.number) return b
  return b.confidence > a.confidence ? b : a
}
