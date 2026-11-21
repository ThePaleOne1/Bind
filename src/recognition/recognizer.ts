import { loadIndex, getCard } from '../api/tcgdex'
import type { CardRecord } from '../data/types'
import { readCard } from './ocr'
import { matchCards, parseOcr, type Candidate, type Parsed } from './matcher'
import { similarity } from '../utils/text'
import type { Roi } from './frameAnalyzer'

export interface Recognition {
  card: CardRecord | null
  confidence: number
  alternatives: Candidate[]
  parsed: Parsed
  ocr: { top: string; bottom: string }
  ms: number
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

export async function recognize(card: HTMLCanvasElement): Promise<Recognition> {
  const t0 = performance.now()
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
  return { card: cardRec, confidence, alternatives: m.alternatives, parsed, ocr, ms: performance.now() - t0 }
}
