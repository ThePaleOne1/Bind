import type { IndexEntry, SetInfo } from '../data/types'
import { normNumber } from '../api/tcgdex'
import { similarity, norm } from '../utils/text'

export interface OcrText {
  top: string      // name band
  bottom: string   // number + illustrator band
  corner?: string  // tight bottom-left crop, number only (read at higher scale)
}

export interface NumberRead {
  number: string
  total: number | null
  weak?: boolean
  /** Both halves came out as three digits ("079191", "034088"): the printed form, hard to hit by chance. */
  padded?: boolean
}

export interface Parsed {
  number: string | null
  total: number | null
  /** The main reading was a guessed split of a digit run with no slash. */
  numberWeak: boolean
  /** ...but both halves were three digits, as printed. */
  numberPadded: boolean
  /** Other ways the digits could be read (slash dropped, second band); tried when the first finds nothing. */
  numberAlts: NumberRead[]
  nameGuess: string
  illustratorGuess: string | null
  /** Set-code-shaped tokens near the number (M2A, SV8A, S6K), uppercased: how a Japanese print is told apart. */
  setCodes: string[]
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
  const push = (number: string, total: number | null, weak = false, padded = false) => {
    if (total != null && (total < 10 || total > 999)) return
    if (!out.some((o) => o.number === number && o.total === total)) out.push({ number, total, ...(weak ? { weak } : {}), ...(padded ? { padded } : {}) })
  }
  // Lettered numbering first (TG01/TG30, GG12/GG70, RC5/RC32, SV001/SV122), then plain 025/198.
  // Lettered numbering carries the letters on both sides (TG12/TG30); "SV 025/198" is the
  // set code sitting next to a plain number and must not be read as SV25.
  const lettered = s.match(/(?<![A-Za-z])((?:TG|GG|RC|SV|SH|SL|SWSH|SM|XY|BW|DP|HGSS)\s?\d{1,3})\s*[\/|]\s*[A-Z]{1,4}\s?(\d{1,3})/i)
  if (lettered) push(normNumber(lettered[1]), parseInt(lettered[2], 10))
  // Plain. The total must end there: "191/ 2024" is the copyright year, not 191/202.
  for (const m of s.matchAll(/(?<!\d)(\d{1,3})\s*[\/|]\s*(\d{1,3})(?!\d)/g)) push(normNumber(m[1]), parseInt(m[2], 10))
  // A stray digit glued on before the number ("1053/191": the rarity mark read as 1), or
  // the slash read as a digit and then as itself ("0807/088", "0807/0880" with a stray 0).
  for (const m of s.matchAll(/(?<!\d)\d(\d{3})\s*[\/|]\s*(\d{3})(?!\d)/g)) push(normNumber(m[1]), parseInt(m[2], 10), true, true)
  for (const m of s.matchAll(/(?<!\d)(\d{3})[714]\s*[\/|]\s*(\d{3})\d?(?!\d)/g)) push(normNumber(m[1]), parseInt(m[2], 10), true, true)
  // Slash lost by the OCR ("04189", "0 04189", "4 189"): split a digit run as n/total both ways.
  for (const m of s.matchAll(/(?<![A-Za-z\d])(\d[\d ]{2,10}\d)(?![A-Za-z\d])/g)) {
    const tokens = m[1].split(' ').filter(Boolean)
    const runs = [tokens.join(''), tokens[tokens.length - 1], tokens.slice(-2).join('')].filter((r, i, a) => r.length >= 4 && r.length <= 7 && a.indexOf(r) === i)
    for (const run of runs) {
      if (/(?:19|20)\d\d$/.test(run)) continue // the copyright year, not a number
      if (run.length === 7) continue
      for (const cut of [3, 2]) {
        const total = parseInt(run.slice(-cut), 10), n = run.slice(0, -cut)
        if (n.length < 1 || n.length > 3) continue
        if (parseInt(n, 10) <= total * 1.5) push(normNumber(n), total, true, cut === 3 && n.length === 3)
      }
    }
  }
  // "SPoJ0327191": number, slash read as a digit (7, 1 or 4), total, often glued to the set
  // code's letters. Only the 3+1+3 split makes sense.
  for (const m of s.matchAll(/(?<!\d)(\d{3})[714](\d{3})\d{0,2}(?!\d)/g)) {
    const total = parseInt(m[2], 10)
    if (parseInt(m[1], 10) <= total * 1.5 && !/^(?:19|20)\d\d$/.test(m[2])) push(normNumber(m[1]), total, true, true)
  }
  // No set size printed (basic energies: "MEE EN 003", "SVE 003"): three digits right after
  // a set code. A guess, since any three digits beside capitals would fit.
  for (const m of s.matchAll(/(?<![A-Za-z])(?!HP|LV)[A-Z]{2,4}[\]\)\|\s]{0,3}(?:EN\s)?(\d{3})(?![\d\/|])/g)) push(normNumber(m[1]), null, true)
  // ...or three digits opening the bottom band ("003 ©2025"), the code having read as junk.
  const lead = s.match(/^[\s(\[|]*(\d{3})(?![\d\/|])/)
  if (lead) push(normNumber(lead[1]), null, true)
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
  const numberPadded = !!reads[0]?.padded
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
  const joined = words.slice(0, 14).join(' ') // several frames may be pooled: keep enough for the name to survive junk
  const nameGuess = joined.length >= 3 ? joined : '' // one or two letters is noise, not a name
  // Code-shaped tokens, plus a three-letter code with the language marker glued on
  // ("SVE EN 009" comes back as "SVEN 009"); codeHit knows to peel the marker off.
  const setCodes = Array.from(new Set(
    `${t.corner ?? ''} ${t.bottom}`.toUpperCase().replace(/-/g, '').split(/[^A-Z0-9+]+/)
      .filter((w) => (/^[A-Z]{1,4}\d{1,2}[A-Z]?$|^[A-Z]{1,2}\d?[A-Z]$|^[A-Z]{3}E?E?N$/.test(w)) && w.length >= 2 && w.length <= 6),
  ))
  return { number, total, numberWeak, numberPadded, numberAlts, nameGuess, illustratorGuess, setCodes }
}

/** Set id as the OCR would see the printed code: "ja:M2a" → "M2A". */
export const codeOf = (set: string) => set.replace(/^ja:/, '').replace(/-/g, '').toUpperCase()

/** The code printed on a set's cards as the OCR would see it: the known abbreviation (SSP) or the set id (M2A). */
export const printedCodeOf = (set: string, sets?: Record<string, SetInfo>) => codeOf(sets?.[set]?.code ?? set)

/** A read token stands for the code when equal, or one character off on a code of four or more. */
export function codeHit(tokens: string[], code: string): boolean {
  if (tokens.includes(code)) return true
  // The language marker glued on: "SVE EN" read as "SVEN" or "SVEEN", "MEE EN" as "MEEN".
  if (tokens.some((t) => t.length > code.length && t.startsWith(code) && /^E?E?N$/.test(t.slice(code.length)))) return true
  // One character off is allowed only on the longer codes with a digit in them (SV8A, S12A):
  // an all-letter code has look-alikes a letter apart ("SVEN" for SVE EN is not SVLN).
  if (code.length < 4 || !/\d/.test(code)) return false
  return tokens.some((t) => t.length === code.length && t.slice(0, 2) === code.slice(0, 2) && [...t].filter((ch, i) => ch !== code[i]).length <= 1)
}

/**
 * Ways to read a name out of the top band. OCR wraps the name in junk ("ge charcadet
 * t7708 eae ae": the BASIC badge, HP, the energy symbol), and the Pokémon's name is
 * nearly always the longest word, so try the longest word, it with each neighbour,
 * and the usual prefixes.
 */
export function nameVariants(guess: string): string[] {
  const words = guess.split(' ').filter(Boolean)
  if (!words.length) return []
  let li = 0
  words.forEach((w, i) => { if (w.length > words[li].length) li = i })
  const v = [
    guess,
    words.slice(0, 2).join(' '),
    words[0],
    words[li],
    li > 0 ? `${words[li - 1]} ${words[li]}` : '',
    li < words.length - 1 ? `${words[li]} ${words[li + 1]}` : '',
  ]
  return v.filter((x, i, a) => x.length >= 3 && a.indexOf(x) === i)
}

const bestSim = (variants: string[], name: string) => {
  let sim = 0
  for (const v of variants) sim = Math.max(sim, similarity(v, name))
  return sim
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
  opts: { prefer?: Set<string>; ja?: boolean } = {},
): MatchResult {
  // Cards come in set batches: a candidate from a recently scanned set gets a small nudge.
  const nudge = (set: string) => (opts.prefer?.has(set) ? 0.04 : 0)
  let parsed = parsedIn
  const { entries } = index
  let scored: Candidate[] = []
  const variants = nameVariants(parsed.nameGuess)

  const scoreNumber = (read: NumberRead, opts2: { printedForm?: boolean } = {}): Candidate[] => {
    const out: Candidate[] = []
    for (const e of entries) {
      if (e.n !== read.number) continue
      let s = 0.45
      if (read.total != null) {
        if (e.total === read.total) s += 0.35
        else if (Math.abs(e.total - read.total) <= 2) s += 0.1
        else if (String(read.total).length >= 2 && String(e.total).startsWith(String(read.total))) s += 0.25   // last digit lost: "116/19"
        else s -= 0.2
      }
      s += nudge(e.set)
      if (e.lang === 'ja') {
        // The name is Japanese and unreadable; the printed set code decides instead. Without
        // it the English card with the same number keeps winning, as it should.
        // "Expect Japanese" mode: a Japanese print needs no code to be in the running.
        s += codeHit(parsed.setCodes, printedCodeOf(e.set, index.sets)) ? 0.3 : opts.ja && !read.weak && read.total != null ? 0.1 : -0.35
      } else {
        // English prints carry a code too from Scarlet & Violet on (SSP, MEE): a match is a
        // nudge; its absence says nothing, older cards have none and the code may not be known.
        if (codeHit(parsed.setCodes, printedCodeOf(e.set, index.sets))) s += 0.2
        if (variants.length) {
          const sim = bestSim(variants, e.name)
          // A clearly different name is evidence against, but only when enough of it was read,
          // and not against the printed form of the number ("034/088" read whole): the name
          // band on a foil card is often junk while the number is right.
          s += 0.3 * sim - (sim < 0.2 && parsed.nameGuess.length >= 4 && !opts2.printedForm ? 0.25 : 0)
        }
      }
      out.push({ entry: e, score: s })
    }
    return out.sort((a, b) => b.score - a.score)
  }

  if (parsed.number) {
    // A guessed split ("079191" with the slash lost) is only trusted with the name agreeing,
    // unless both halves came out zero-padded to three digits and the set size is exact:
    // that is the printed form and hard to hit by chance.
    const padded = parsed.numberWeak && parsed.numberPadded && parsed.total != null && index.entries.some((e) => e.n === parsed.number && e.total === parsed.total)
    // The printed form outranks a junk name, not a clearly read one: "mesprit" beside
    // "070/191" still says this is not card 070.
    const nameReadable = padded && variants.length > 0 && entries.some((e) => e.total === parsed.total && bestSim(variants, e.name) >= 0.5)
    scored = scoreNumber({ number: parsed.number, total: parsed.total }, { printedForm: padded && !nameReadable })
    // Three digits with no set size are only read right after a set code (energies: "MEE 003");
    // when that code is the best candidate's own, the read is the printed form too.
    const coded = parsed.numberWeak && parsed.total == null && scored.length > 0 && codeHit(parsed.setCodes, printedCodeOf(scored[0].entry.set, index.sets))
    if (parsed.numberWeak && scored.length && scored[0].score < (padded ? 0.78 : coded ? 0.6 : 0.92)) scored = []
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
    for (const e of entries) {
      if (seen.has(e.id) || e.lang === 'ja') continue
      const sim = bestSim(variants, e.name)
      if (sim <= 0.55) continue
      // The set total is usually read right even when the number is not: a name match
      // in a set with that total is near-certain.
      const totalHit = parsed.total != null && e.total === parsed.total
      scored.push({ entry: e, score: sim * 0.6 + (totalHit ? 0.3 : 0) + nudge(e.set) })
    }
  }

  scored.sort((a, b) => b.score - a.score)
  const best = scored[0] ?? null
  const second = scored[1]
  let confidence = best ? Math.min(1, best.score) : 0
  if (best && second && second.score > best.score - 0.05) confidence *= 0.6 // ambiguous
  // A Japanese print with the same number and set size as an English best whose name did
  // not really read: do not commit the English card; bring the twin within reach and let
  // the tie-break decide on the illustrator credit, which is Latin on Japanese cards too.
  if (best && best.entry.lang !== 'ja') {
    const simBest = variants.length ? bestSim(variants, best.entry.name) : 0
    if (simBest < 0.5) {
      const twin = scored.find((c) => c.entry.lang === 'ja' && c.entry.n === best.entry.n && c.entry.total === best.entry.total)
      if (twin) {
        twin.score = Math.max(twin.score, best.score - 0.05)
        confidence = Math.min(confidence, 0.6)
        scored.sort((a, b) => b.score - a.score)
      }
    }
  }
  return { best: scored[0] ?? null, alternatives: scored.slice(0, 12), parsed, confidence }
}

/* ---------- Fuzzy number comparison ----------
 * Italic digits on foil come back noisy: "032/191" as "10327757", "1032719110" or
 * "F357 79110". The slash turns into 7 or 1, 1 and 7 swap, 9 and 5 swap, and the
 * rarity dot after the number becomes a 0. Once the name has narrowed the field,
 * each candidate's number is scored against the digit runs with cheap costs for
 * exactly those confusions.
 */
// Italic bold digits (the collector number) add 0↔5 and 2↔5 to the usual mix.
const CONFUSABLE: Record<string, string> = { '1': '7/|', '7': '1/', '9': '5', '5': '902', '0': '85', '8': '03', '3': '8', '6': '8', '2': '75' }
const confusable = (a: string, b: string) => a === b ? 0 : (CONFUSABLE[a]?.includes(b) || CONFUSABLE[b]?.includes(a)) ? 0.3 : 1

/** All digit runs in a piece of OCR (spaces inside a run removed), longest first. */
export function digitRuns(text: string): string[] {
  const runs = new Set<string>()
  const year = (r: string) => /^0?(?:19|20)\d\d$/.test(r) // the copyright line, not a number
  for (const m of text.matchAll(/\d[\d /|]*\d/g)) {
    const r = m[0].replace(/[^\d]/g, '')
    if (r.length >= 4 && !year(r)) runs.add(r)
    for (const part of m[0].split(/[ /|]+/)) if (part.length >= 4 && !year(part)) runs.add(part)
  }
  return [...runs].sort((a, b) => b.length - a.length)
}

/**
 * Cost of finding `canon` (e.g. "032191") somewhere inside `run`: substitutions by
 * confusability, an extra character in the run (slash, dot) costs 0.4, a missing one
 * costs 1. Leading and trailing junk in the run is free.
 */
function containCost(run: string, canon: string): number {
  const n = run.length, m = canon.length
  let prev = new Float32Array(m + 1), cur = new Float32Array(m + 1)
  for (let j = 1; j <= m; j++) prev[j] = j
  let best = prev[m]
  for (let i = 1; i <= n; i++) {
    cur[0] = 0 // free prefix
    for (let j = 1; j <= m; j++) {
      cur[j] = Math.min(prev[j - 1] + confusable(run[i - 1], canon[j - 1]), prev[j] + 0.4, cur[j - 1] + 1)
    }
    best = Math.min(best, cur[m]) // free suffix: the match may end here
    ;[prev, cur] = [cur, prev]
  }
  return best
}

/** 0–1 similarity between a card's number and the digit runs read from the card. */
export function numberSimilarity(runs: string[], n: string, total: number): number {
  if (!/^\d+$/.test(n) || !total) return 0
  const canon = n.padStart(3, '0') + String(total).padStart(3, '0')
  let best = 0
  for (const r of runs) {
    if (r.length < 4) continue
    best = Math.max(best, 1 - containCost(r, canon) / canon.length)
  }
  return best
}

/**
 * How strongly the OCR text supports a given illustrator. The credit line comes back
 * as "ilu YKarivg", "illysYKariyol" or "3Karival" for "Illus. Kariya", so instead of
 * parsing the prefix, look for the illustrator's main name token inside each OCR
 * word: the share of its letter bigrams that the word contains (0–1).
 */
export function illustratorEvidence(text: string, illustrator: string | null | undefined): number {
  if (!illustrator) return 0
  const tokens = illustrator.toLowerCase().replace(/[^a-z ]/g, ' ').split(' ').filter((t) => t.length >= 4)
  if (!tokens.length) return 0
  const name = tokens.reduce((a, b) => (b.length > a.length ? b : a))
  const grams: string[] = []
  for (let i = 0; i < name.length - 1; i++) grams.push(name.slice(i, i + 2))
  const words = text.toLowerCase().replace(/[^a-z]+/g, ' ').split(' ').filter((w) => w.length >= 4)
  let best = 0
  for (const w of words) {
    let hit = 0
    for (const g of grams) if (w.includes(g)) hit++
    best = Math.max(best, hit / grams.length)
  }
  return best
}

export interface SearchQuery {
  name?: string
  /** Number, with or without the set size, and/or the set code printed beside it: "25/102", "003", "MEE 003", "M2a 110/193". */
  number?: string
  /** Keep one catalogue: English prints, or Japanese ones (whose names are in Japanese). */
  lang?: 'en' | 'ja'
  /** Only these card ids (every print of one Pokédex number, looked up beforehand). */
  ids?: Set<string>
}

/**
 * "No.021" / "#21" in a number field: the Pokédex number that old Japanese cards print
 * instead of a collector number. Returns it and the field without it.
 */
export function splitDex(s: string): { dex: number | null; rest: string } {
  const m = s.match(/(?:^|\s)(?:no\.?\s*|#)(\d{1,4})(?=\s|$)/i)
  if (!m || m.index == null) return { dex: null, rest: s }
  return { dex: parseInt(m[1], 10), rest: (s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length)).trim() }
}

/** "sv08" / "SV8" / "SSP" / "ja:M2a" → a key both the typed and the stored forms reduce to. */
const codeKey = (s: string) => codeOf(s).replace(/^([A-Z]+)0+(\d)/, '$1$2')

/**
 * Search the local index. A set code in the number field narrows the search to that set
 * (so "MEE 003" is the one Water Energy and not every print numbered 3); "EN"/"JP"
 * markers printed beside the code are ignored. With a set and nothing else, the whole set
 * is listed in number order.
 */
export function searchIndex(q: SearchQuery, index: { entries: IndexEntry[]; sets: Record<string, SetInfo> }, limit = 40) {
  const name = norm(q.name ?? '')
  const inLang = (lang: 'ja' | undefined) => (q.lang === 'ja' ? lang === 'ja' : q.lang === 'en' ? lang !== 'ja' : true)
  const setsByCode = new Map<string, string[]>()
  for (const s of Object.values(index.sets)) {
    if (!inLang(s.lang)) continue
    for (const k of [codeKey(s.id), s.code ? codeKey(s.code) : null]) if (k) setsByCode.set(k, [...(setsByCode.get(k) ?? []), s.id])
  }
  let sets: Set<string> | null = null
  const rest: string[] = []
  for (const tok of (q.number ?? '').trim().split(/\s+/)) {
    if (!tok || /^(EN|JP|JA)$/i.test(tok)) continue
    const hit = /^[A-Za-z][A-Za-z0-9.]{1,6}$/.test(tok) ? setsByCode.get(codeKey(tok)) : undefined
    if (hit) { sets = new Set([...(sets ?? []), ...hit]); continue }
    rest.push(tok)
  }
  const text = rest.join(' ')
  const frac = text.match(/([A-Za-z]{0,5}\d{1,3})\s*\/\s*(\d{1,3})/)
  const lone = !frac && text.match(/\b([A-Za-z]{0,5}\d{1,3})\b/)
  const number = frac ? normNumber(frac[1]) : lone ? normNumber(lone[1]) : null
  const total = frac ? parseInt(frac[2], 10) : null
  if (!name && !number && !sets && !q.ids) return []
  const out: Candidate[] = []
  for (const e of index.entries) {
    if (!inLang(e.lang)) continue
    if (sets && !sets.has(e.set)) continue
    if (q.ids && !q.ids.has(e.id)) continue
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
  out.sort((a, b) => b.score - a.score) // stable: ties keep catalogue (number) order
  return out.slice(0, limit)
}
