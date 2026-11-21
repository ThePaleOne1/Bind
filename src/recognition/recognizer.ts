import { loadIndex, getCard } from '../api/tcgdex'
import type { CardRecord } from '../data/types'
import { readPrimary, readBottom, debugBands } from './ocr'
import { matchCards, parseOcr, digitRuns, numberSimilarity, illustratorEvidence, type Candidate, type Parsed } from './matcher'
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

/**
 * Recognise a card. With `prior` (a failed attempt on an earlier frame of the same
 * card) the OCR text of both frames is pooled: foil makes digits come out differently
 * each frame, so two noisy reads give the number and illustrator matching more to go on.
 */
export async function recognize(card: HTMLCanvasElement, opts: { debug?: boolean; prior?: Recognition } = {}): Promise<Recognition> {
  const t0 = performance.now()
  // Nothing printed in the frame (empty jig, table): skip the OCR, which is slow on noise.
  if (contrastOf(card) < MIN_CONTRAST) {
    const out: Recognition = { ...EMPTY, ms: performance.now() - t0, sharpness: 0 }
    if (opts.debug) out.bands = debugBands(card)
    return out
  }
  // Phase 1: name band + number corner (parallel). That settles most modern cards.
  const [index, primary] = await Promise.all([loadIndex(), readPrimary(card)])
  const prior = opts.prior?.ocr
  const join = (a: string, b?: string) => (b ? `${a} ${b}` : a)
  const ocr = { top: join(primary.top, prior?.top), bottom: prior?.bottom ?? '', corner: join(primary.corner, prior?.corner) }
  let parsed = parseOcr(ocr)
  let m = matchCards(parsed, index)
  // Phase 2: the wide bottom band, only when the corner did not settle it
  // (number missing, weak match, or two cards within reach of each other).
  const settled = m.best && m.confidence >= 0.8 && !(m.alternatives[1] && m.alternatives[1].score >= m.best.score - 0.12)
  if (!settled) {
    ocr.bottom = join(await readBottom(card), prior?.bottom)
    parsed = parseOcr(ocr)
    m = matchCards(parsed, index)
  }
  let best = m.best
  let confidence = m.confidence

  // Several cards within reach of each other (same name, number unreadable): rank them
  // by the noisy digit runs and the illustrator credit, and commit when one stands out.
  let alternatives = m.alternatives
  const close = m.alternatives.filter((a) => best && a.score >= best.score - 0.12).slice(0, 12)
  if (best && close.length > 1 && confidence < 0.8) {
    const { ranked, pick } = await tieBreak(ocr, close)
    alternatives = [...ranked.map((r) => r.c), ...m.alternatives.filter((a) => !close.includes(a))]
    if (pick) { best = pick.c; confidence = Math.max(confidence, pick.s >= 0.7 ? 0.9 : 0.8) }
  }

  let cardRec: CardRecord | null = null
  if (best && confidence >= 0.5) {
    cardRec = await getCard(best.entry.id).catch(() => null)
  }
  const out: Recognition = { card: cardRec, confidence, alternatives, parsed, ocr, ms: performance.now() - t0, sharpness: sharpnessOf(card) }
  if (opts.debug) out.bands = debugBands(card)
  return out
}

export interface Ranked { c: Candidate; num: number; ill: number; s: number }

/**
 * Rank look-alike candidates by (a) how well each card's number fits the digit runs
 * the OCR produced, with cheap costs for the usual digit confusions, and (b) whether
 * the card's illustrator shows up in the bottom text. Picks the top one only when it
 * clearly beats the runner-up.
 */
export async function tieBreak(ocr: { corner: string; bottom: string }, close: Candidate[]): Promise<{ ranked: Ranked[]; pick: Ranked | null }> {
  const runs = digitRuns(`${ocr.corner} ${ocr.bottom}`)
  const details = await Promise.all(close.map((c) => getCard(c.entry.id).catch(() => null)))
  const text = `${ocr.bottom} ${ocr.corner}`
  const ranked: Ranked[] = close.map((c, i) => {
    const num = numberSimilarity(runs, c.entry.n, c.entry.total)
    const illRaw = illustratorEvidence(text, details[i]?.illustrator)
    const ill = illRaw >= 0.5 ? illRaw : 0
    return { c, num, ill, s: 0.65 * num + 0.35 * ill }
  }).sort((a, b) => b.s - a.s)
  const [t, u] = ranked
  const pick = t && t.s >= 0.45 && (!u || t.s - u.s >= 0.1) ? t : null
  return { ranked, pick }
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
