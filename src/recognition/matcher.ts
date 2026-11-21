import type { IndexEntry, SetInfo } from '../data/types'
import { normNumber } from '../api/tcgdex'
import { similarity, norm } from '../utils/text'

export interface OcrText {
  top: string      // name band
  bottom: string   // number + illustrator band
}

export interface Parsed {
  number: string | null
  total: number | null
  nameGuess: string
  illustratorGuess: string | null
}

const STOP = new Set([
  'hp', 'basic', 'stage', 'stage1', 'stage2', 'trainer', 'item', 'supporter', 'stadium', 'tool', 'energy', 'special',
  'pokemon', 'ex', 'gx', 'v', 'vmax', 'vstar', 'tag', 'team', 'break', 'prism', 'star', 'level', 'lv', 'up', 'evolves',
  'from', 'put', 'on', 'the', 'radiant', 'ancient', 'future', 'tera', 'mega', 'illus', 'illustrator',
])

const PROMO_RE = /\b((?:SWSH|SVP|SM|XY|BW|DP|HGSS|TG|GG|SV|RC|SH|SL|MEP|ME)\s?\d{1,3})\b/i

export function parseOcr(t: OcrText): Parsed {
  const bottom = t.bottom.replace(/[|Il]\s*(?=\d)/g, '1').replace(/[oO](?=\d|\/)/g, '0')
  let number: string | null = null
  let total: number | null = null
  // Lettered numbering first (TG01/TG30, GG12/GG70, RC5/RC32, SV001/SV122), then plain 025/198.
  const lettered = bottom.match(/(?<![A-Za-z])((?:TG|GG|RC|SV|SH|SL|SWSH|SM|XY|BW|DP|HGSS)\s?\d{1,3})\s*[\/|]\s*(?:[A-Z]{0,4}\s?)(\d{1,3})/i)
  const frac = lettered ?? bottom.match(/(?<!\d)(\d{1,3})\s*[\/|]\s*(\d{1,3})(?!\d)/)
  if (frac) {
    number = normNumber(frac[1])
    total = parseInt(frac[2], 10)
  } else {
    const promo = bottom.match(PROMO_RE)
    if (promo) number = normNumber(promo[1])
  }

  // Illustrator credit: "Illus. Name" or "Illustrator: Name"
  let illustratorGuess: string | null = null
  const ill = t.bottom.match(/illus(?:trator)?\.?\s*:?\s*([A-Za-z][A-Za-z .'\-]{1,40})/i)
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
  const nameGuess = words.slice(0, 5).join(' ')
  return { number, total, nameGuess, illustratorGuess }
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
  parsed: Parsed,
  index: { entries: IndexEntry[]; sets: Record<string, SetInfo> },
): MatchResult {
  const { entries } = index
  let pool: IndexEntry[] = []
  const scored: Candidate[] = []

  if (parsed.number) {
    pool = entries.filter((e) => e.n === parsed.number)
    for (const e of pool) {
      let s = 0.45
      if (parsed.total != null) {
        if (e.total === parsed.total) s += 0.35
        else if (Math.abs(e.total - parsed.total) <= 2) s += 0.1
        else s -= 0.2
      }
      if (parsed.nameGuess) {
        const sim = similarity(parsed.nameGuess, e.name)
        s += 0.3 * sim - (sim < 0.2 ? 0.25 : 0) // a clearly different name is strong evidence against
      }
      scored.push({ entry: e, score: s })
    }
  }

  if (scored.length === 0 && parsed.nameGuess.length >= 3) {
    // Name-only fallback: top name matches, all sets
    for (const e of entries) {
      const sim = similarity(parsed.nameGuess, e.name)
      if (sim > 0.55) scored.push({ entry: e, score: sim * 0.6 })
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
