import { loadIndex, getCard } from '../api/tcgdex'
import type { CardRecord } from '../data/types'
import { readPrimary, readBottom, debugBands } from './ocr'
import { matchCards, parseOcr, digitRuns, numberSimilarity, illustratorEvidence, type Candidate, type Parsed } from './matcher'
import { similarity } from '../utils/text'
import type { Roi } from './frameAnalyzer'
import { sharpnessOf } from './focus'
import { readFoil, type FoilRead } from './foil'

export interface Recognition {
  card: CardRecord | null
  confidence: number
  alternatives: Candidate[]
  parsed: Parsed
  ocr: { top: string; bottom: string; corner: string }
  ms: number
  /** Time spent inside the OCR workers (part of ms). */
  ocrMs?: number
  sharpness: number
  /** Nothing printed in the frame (empty jig, table): OCR was skipped. */
  empty?: boolean
  foil?: FoilRead
  bands?: { top: string; bottom: string; corner: string } // preprocessed band images (debug)
}

/**
 * Grab the guide region of the live video for reading.
 *
 * Two reusable software canvases (a fresh GPU canvas per grab is 14 MB at 4K and the
 * phone reclaims them slowly). Software on purpose: the one drawImage(video) is the
 * only GPU round-trip; every band crop after it is CPU → CPU. The card is capped at
 * MAX_CAPTURE_H tall, which still leaves the name band ~170 px tall before OCR
 * resampling; 4K would give 2200 px of card and nothing to show for it.
 * `avoid` is a canvas still in use (the previous grab being compared against).
 */
const MAX_CAPTURE_H = 1800
const slots: HTMLCanvasElement[] = []
/** A pixel rectangle of any image source (video frame, full-resolution still) into a reusable canvas. */
export function grabRegion(src: CanvasImageSource, r: { x: number; y: number; w: number; h: number }, avoid?: HTMLCanvasElement): HTMLCanvasElement {
  if (slots.length < 2) { slots.push(document.createElement('canvas')); slots.push(document.createElement('canvas')) }
  const c = slots[0] === avoid ? slots[1] : slots[0]
  const sw = Math.max(1, Math.round(r.w)), sh = Math.max(1, Math.round(r.h))
  const scale = Math.min(1, MAX_CAPTURE_H / sh)
  const w = Math.max(1, Math.round(sw * scale)), h = Math.max(1, Math.round(sh * scale))
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h }
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(src, r.x, r.y, sw, sh, 0, 0, w, h)
  return c
}
export function captureRoi(video: HTMLVideoElement, roi: Roi, avoid?: HTMLCanvasElement): HTMLCanvasElement {
  const vw = video.videoWidth, vh = video.videoHeight
  return grabRegion(video, { x: roi.x * vw, y: roi.y * vh, w: roi.w * vw, h: roi.h * vh }, avoid)
}

/** Crop a rectangle (frame pixels) out of a grabbed frame into a reusable software canvas. */
const cropSlots: HTMLCanvasElement[] = []
export function cropCanvas(src: HTMLCanvasElement, r: { x: number; y: number; w: number; h: number }, avoid?: HTMLCanvasElement): HTMLCanvasElement {
  if (cropSlots.length < 2) { cropSlots.push(document.createElement('canvas')); cropSlots.push(document.createElement('canvas')) }
  const c = cropSlots[0] === avoid ? cropSlots[1] : cropSlots[0]
  const w = Math.max(1, Math.round(r.w)), h = Math.max(1, Math.round(r.h))
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h }
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(src, r.x, r.y, r.w, r.h, 0, 0, w, h)
  return c
}

export async function setNameOf(setId: string): Promise<string> {
  const idx = await loadIndex()
  return idx.sets[setId]?.name ?? setId.toUpperCase()
}

/** Standard deviation of brightness over the card region (0–1). A printed card is busy; a bare jig or table is flat. */
const small = document.createElement('canvas')
small.width = 48; small.height = 64
const smallCtx = small.getContext('2d', { willReadFrequently: true })!
export function contrastOf(card: HTMLCanvasElement): number {
  smallCtx.drawImage(card, 0, 0, 48, 64)
  const d = smallCtx.getImageData(0, 0, 48, 64).data
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
export async function recognize(card: HTMLCanvasElement, opts: { debug?: boolean; prior?: Recognition; prefer?: Set<string> } = {}): Promise<Recognition> {
  const t0 = performance.now()
  // Nothing printed in the frame (empty jig, table): skip the OCR, which is slow on noise.
  if (contrastOf(card) < MIN_CONTRAST) {
    const out: Recognition = { ...EMPTY, ms: performance.now() - t0, sharpness: 0, empty: true }
    if (opts.debug) out.bands = debugBands(card)
    return out
  }
  // Phase 1: name band + number corner (parallel). That settles most modern cards.
  const t1 = performance.now()
  const [index, primary] = await Promise.all([loadIndex(), readPrimary(card)])
  let ocrMs = performance.now() - t1
  const prior = opts.prior?.ocr
  const join = (a: string, b?: string) => (b ? `${a} ${b}` : a)
  const ocr = { top: join(primary.top, prior?.top), bottom: prior?.bottom ?? '', corner: join(primary.corner, prior?.corner) }
  let parsed = parseOcr(ocr)
  let m = matchCards(parsed, index, { prefer: opts.prefer })
  // Phase 2: the wide bottom band, only when the corner did not settle it
  // (number missing, weak match, or two cards within reach of each other).
  const settled = m.best && m.confidence >= 0.8 && !(m.alternatives[1] && m.alternatives[1].score >= m.best.score - 0.12)
  if (!settled) {
    const t2 = performance.now()
    ocr.bottom = join(await readBottom(card), prior?.bottom)
    ocrMs += performance.now() - t2
    parsed = parseOcr(ocr)
    m = matchCards(parsed, index, { prefer: opts.prefer })
  }
  let best = m.best
  let confidence = m.confidence

  // Several cards within reach of each other (same name, number unreadable): rank them
  // by the noisy digit runs and the illustrator credit, and commit when one stands out.
  let alternatives = m.alternatives
  const close = m.alternatives.filter((a) => best && a.score >= best.score - 0.12).slice(0, 40)
  if (best && close.length > 1 && confidence < 0.8) {
    const { ranked, pick } = await tieBreak(ocr, close, opts.prefer)
    alternatives = [...ranked.map((r) => r.c), ...m.alternatives.filter((a) => !close.includes(a))]
    if (pick) { best = pick.c; confidence = Math.max(confidence, pick.s >= 0.7 ? 0.9 : 0.8) }
  }

  let cardRec: CardRecord | null = null
  if (best && confidence >= 0.5) {
    cardRec = await getCard(best.entry.id, { quick: true }).catch(() => null)
  }
  const out: Recognition = { card: cardRec, confidence, alternatives, parsed, ocr, ms: performance.now() - t0, ocrMs, sharpness: sharpnessOf(card), foil: readFoil(card) }
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
export async function tieBreak(ocr: { corner: string; bottom: string }, close: Candidate[], prefer?: Set<string>): Promise<{ ranked: Ranked[]; pick: Ranked | null }> {
  const runs = digitRuns(`${ocr.corner} ${ocr.bottom}`)
  const text = `${ocr.bottom} ${ocr.corner}`
  // Number fit first (no network), then the illustrator credit for the few that fit best:
  // each of those needs the card's details, a fetch on slow data when not cached.
  const byNum = close.map((c) => ({ c, num: numberSimilarity(runs, c.entry.n, c.entry.total) + (prefer?.has(c.entry.set) ? 0.08 : 0) })).sort((a, b) => b.num - a.num)
  const top = byNum.slice(0, 4)
  const details = await Promise.all(top.map((t) => getCard(t.c.entry.id, { quick: true }).catch(() => null)))
  const ranked: Ranked[] = byNum.map((t, i) => {
    const illRaw = i < top.length ? illustratorEvidence(text, details[i]?.illustrator) : 0
    const ill = illRaw >= 0.5 ? illRaw : 0
    return { c: t.c, num: t.num, ill, s: 0.65 * t.num + 0.35 * ill }
  }).sort((a, b) => b.s - a.s)
  const [t, u] = ranked
  const pick = t && t.s >= 0.45 && (!u || t.s - u.s >= 0.1) ? t : null
  return { ranked, pick }
}

/** True when the OCR found essentially nothing (no number, no candidate), or the frame was empty. */
export function isBlank(r: Recognition): boolean {
  return !!r.empty || (!r.parsed.number && r.alternatives.length === 0)
}

/** Prefer the attempt that read a collector number; otherwise the more confident one. */
export function betterOf(a: Recognition, b: Recognition): Recognition {
  if (a.card && !b.card) return a
  if (b.card && !a.card) return b
  if (a.parsed.number && !b.parsed.number) return a
  if (b.parsed.number && !a.parsed.number) return b
  return b.confidence > a.confidence ? b : a
}
