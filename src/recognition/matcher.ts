import type { IndexEntry, SetInfo } from '../data/types'
import { normNumber } from '../api/tcgdex'
import { similarity, norm } from '../utils/text'

export interface OcrText {
  top: string      // name band
  bottom: string   // number + illustrator band
  corner?: string  // tight bottom-left crop, number only (read at higher scale)
}

export interface NumberRead { number: string; total: number | null; weak?: boolean }

export interface Parsed {
  number: string | null
  total: number | null
  /** The main reading was a guessed split of a digit run with no slash. */
  numberWeak: boolean
  /** Other ways the digits could be read (slash dropped, second band); tried when the first finds nothing. */
  numberAlts: NumberRead[]
  nameGuess: string
  illustratorGuess: string | null
}

const STOP = new Set([
  'hp', 'basic', 'stage', 'stage1', 'stage2', 'trainer', 'item', 'supporter', 'stadium', 'tool', 'energy', 'special',
  'pokemon', 'ex', 'gx', 'v', 'vmax', 'vstar', 'tag', 'team', 'break', 'prism', 'star', 'level', 'lv', 'up', 'evolves',
  'from', 'put', 'on', 'the', 'radiant', 'ancient', 'future', 'tera', 'mega', 'illus', 'illustrator',
])

const PROMO_RE = /\b((?:SWSH|SVP|SM|XY|BW|DP|HGSS|TG|GG|SV|RC|SH|SL|MEP|ME)\s?\d{1,3})\b/i

/** Common OCR confusions in a numeric context. */
const fixDigits = (s: string) =>
  s
    .replace(/(?<![A-Za-z])[|Il](?=\d)/g, '1')      // "l25/198" → "125/198" (but not "Fl 090")
    .replace(/(?<=\d)[|Il](?![A-Za-z])/g, '1')      // "12l/198" → "121/198"
    .replace(/(?<=\d)[oO]|[oO](?=\d{2})/g, '0')     // "1o0/167" → "100/167"
    .replace(/(?<=\d)[sS](?=\d|\/)/g, '5')

/** Every plausible collector-number reading in a piece of OCR text, best first. */
function findNumbers(text: string): NumberRead[] {
  const s = fixDigits(text)
  const out: NumberRead[] = []
  const push = (number: string, total: number | null, weak = false) => {
    if (total != null && (total < 10 || total > 999)) return
    if (!out.some((o) => o.number === number && o.total === total)) out.push(weak ? { number, total, weak } : { number, total })
  }
  // Lettered numbering first (TG01/TG30, GG12/GG70, RC5/RC32, SV001/SV122), then plain 025/198.
  const lettered = s.match(/(?<![A-Za-z])((?:TG|GG|RC|SV|SH|SL|SWSH|SM|XY|BW|DP|HGSS)\s?\d{1,3})\s*[\/|]\s*(?:[A-Z]{0,4}\s?)(\d{1,3})/i)
  if (lettered) push(normNumber(lettered[1]), parseInt(lettered[2], 10))
  // Plain: a stray digit glued on after the total ("230/2365") is tolerated.
  for (const m of s.matchAll(/(?<!\d)(\d{1,3})\s*[\/|]\s*(\d{1,3})/g)) push(normNumber(m[1]), parseInt(m[2], 10))
  // Slash lost by the OCR ("04189", "0 04189", "4 189"): split a digit run as n/total both ways.
  for (const m of s.matchAll(/(?<![A-Za-z\d])(\d[\d ]{2,10}\d)(?![A-Za-z\d])/g)) {
    const tokens = m[1].split(' ').filter(Boolean)
    const runs = [tokens.join(''), tokens[tokens.length - 1], tokens.slice(-2).join('')].filter((r, i, a) => r.length >= 4 && r.length <= 6 && a.indexOf(r) === i)
    for (const run of runs) {
      if (/(?:19|20)\d\d$/.test(run)) continue // the copyright year, not a number
      for (const cut of [3, 2]) {
        const total = parseInt(run.slice(-cut), 10), n = run.slice(0, -cut)
        if (n.length < 1 || n.length > 3) continue
        if (parseInt(n, 10) <= total * 1.5) push(normNumber(n), total, true)
      }
    }
  }
  const promo = s.match(PROMO_RE)
  if (promo) push(normNumber(promo[1]), null)
  return out
}

export function parseOcr(t: OcrText): Parsed {
  // The tight corner crop is read at a higher scale, so trust it first; the rest are fallbacks.
  const reads = [...(t.corner ? findNumbers(t.corner) : []), ...findNumbers(t.bottom)]
    .filter((r, i, a) => a.findIndex((o) => o.number === r.number && o.total === r.total) === i)
  const number = reads[0]?.number ?? null
  const total = reads[0]?.total ?? null
  const numberWeak = !!reads[0]?.weak
  const numberAlts = reads.slice(1, 8)

  // Illustrator credit: "Illus. Name" or "Illustrator: Name"
  let illustratorGuess: string | null = null
  const ill = `${t.bottom} ${t.corner ?? ''}`.match(/illus(?:trator)?\.?\s*:?\s*([A-Za-z0-9][A-Za-z0-9 .'\-]{1,40})/i)
  if (ill) {
    illustratorGuess = ill[1]
      .replace(/\s(?:TG|GG|RC|SV|SH|SL|SWSH|SM|XY|BW|DP|HGSS)?\d.*$/i, '') // cut at the collector number
      .replace(/\s+[A-Z]{1,4}$/, '')                                         // dangling prefix like " TG"
      .replace(/\s{2,}/g, ' ').trim().replace(/[^A-Za-z]+$/, '')
    if (illustratorGuess.length < 3) illustratorGuess = null
  }

  // Name: strip HP numbers and card-type words from the top band
  const words = norm(t.top)
    .split(' ')
    .filter((w) => w && !STOP.has(w) && !/^\d+$/.test(w) && !/^(hp\d*|\d+hp|lv\d*)$/.test(w) && w.length > 1)
  const joined = words.slice(0, 5).join(' ')
  const nameGuess = joined.length >= 3 ? joined : '' // one or two letters is noise, not a name
  return { number, total, numberWeak, numberAlts, nameGuess, illustratorGuess }
}

export interface Candidate {
  entry: IndexEntry
  score: number
}

export interface MatchResult {
  best: Candidate | null
  alternatives: Candidate[]
  parsed: Parsed
  confidence: number
}

export function matchCards(
  parsedIn: Parsed,
  index: { entries: IndexEntry[]; sets: Record<string, SetInfo> },
): MatchResult {
  let parsed = parsedIn
  const { entries } = index
  let scored: Candidate[] = []

  const scoreNumber = (read: NumberRead): Candidate[] => {
    const out: Candidate[] = []
    for (const e of entries) {
      if (e.n !== read.number) continue
      let s = 0.45
      if (read.total != null) {
        if (e.total === read.total) s += 0.35
        else if (Math.abs(e.total - read.total) <= 2) s += 0.1
        else s -= 0.2
      }
      if (parsed.nameGuess) {
        const sim = similarity(parsed.nameGuess, e.name)
        // A clearly different name is evidence against, but only when enough of it was read.
        s += 0.3 * sim - (sim < 0.2 && parsed.nameGuess.length >= 4 ? 0.25 : 0)
      }
      out.push({ entry: e, score: s })
    }
    return out.sort((a, b) => b.score - a.score)
  }

  if (parsed.number) {
    scored = scoreNumber({ number: parsed.number, total: parsed.total })
    if (parsed.numberWeak && scored.length && scored[0].score < 0.92) scored = []
  }
  // The first reading found no card with that number and total: try the other readings.
  // A reading with a real slash needs number + total to match a card outright; a guessed
  // split (slash dropped) also needs the name to agree, or it is too easy to hit by chance.
  if (!scored.length || scored[0].score < 0.8) {
    for (const alt of parsed.numberAlts) {
      const alted = scoreNumber(alt)
      const need = alt.weak ? 0.92 : 0.8
      if (alted.length && alted[0].score >= need) {
        scored = alted
        parsed = { ...parsed, number: alt.number, total: alt.total }
        break
      }
    }
  }

  // Name fallback when the number gave nothing usable (misread digits are common under glare).
  const numberWeak = scored.length === 0 || scored[0].score < 0.5
  if (numberWeak && parsed.nameGuess.length >= 3) {
    const seen = new Set(scored.map((c) => c.entry.id))
    // OCR often appends junk after the name ("charizard ie of by"); try shorter prefixes too.
    const words = parsed.nameGuess.split(' ')
    const variants = [parsed.nameGuess, words.slice(0, 2).join(' '), words[0]].filter((v, i, a) => v.length >= 3 && a.indexOf(v) === i)
    for (const e of entries) {
      if (seen.has(e.id)) continue
      let sim = 0
      for (const v of variants) sim = Math.max(sim, similarity(v, e.name))
      if (sim <= 0.55) continue
      // The set total is usually read right even when the number is not: a name match
      // in a set with that total is near-certain.
      const totalHit = parsed.total != null && e.total === parsed.total
      scored.push({ entry: e, score: sim * 0.6 + (totalHit ? 0.3 : 0) })
    }
  }

  scored.sort((a, b) => b.score - a.score)
  const best = scored[0] ?? null
  const second = scored[1]
  let confidence = best ? Math.min(1, best.score) : 0
  if (best && second && second.score > best.score - 0.05) confidence *= 0.6 // ambiguous
  return { best, alternatives: scored.slice(0, 8), parsed, confidence }
}

/** Search the local index by free text ("pikachu 25/102", "charizard 006") */
export function searchIndex(q: string, index: { entries: IndexEntry[]; sets: Record<string, SetInfo> }, limit = 40) {
  const text = q.trim()
  if (!text) return []
  const frac = text.match(/([A-Za-z]{0,5}\d{1,3})\s*\/\s*(\d{1,3})/)
  const lone = !frac && text.match(/\b([A-Za-z]{0,5}\d{1,3})\b/)
  const number = frac ? normNumber(frac[1]) : lone ? normNumber(lone[1]) : null
  const total = frac ? parseInt(frac[2], 10) : null
  const name = norm(text.replace(/([A-Za-z]{0,5}\d{1,3})\s*(\/\s*\d{1,3})?/g, ' ')).trim()
  const out: Candidate[] = []
  for (const e of index.entries) {
    let s = 0
    if (number) {
      if (e.n !== number) continue
      s += 0.5
      if (total != null) s += e.total === total ? 0.4 : -0.3
    }
    if (name) {
      const sim = similarity(name, e.name)
      const starts = norm(e.name).startsWith(name)
      if (!number && sim < 0.4 && !starts) continue
      s += 0.5 * sim + (starts ? 0.2 : 0)
    }
    out.push({ entry: e, score: s })
  }
  out.sort((a, b) => b.score - a.score)
  return out.slice(0, limit)
}
