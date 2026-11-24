import type { Finish } from './types'

/**
 * The scanner's test deck: the cards the user runs through every build, with what each
 * really is. The bench scans each one several times and sends every read with its crop,
 * so a session in any lighting yields labelled data instead of a typed-up summary.
 */
export interface BenchCard {
  name: string          // as printed
  number: string        // as printed
  expected: string[]    // card ids that count as a hit (Japanese sets can share a print)
  finish: Finish        // the true finish of the user's copy
  note?: string
}

export const BENCH_CARDS: BenchCard[] = [
  { name: 'Mesprit', number: '079/191', expected: ['sv08-079'], finish: 'normal' },
  { name: 'Appletun', number: '140/191', expected: ['sv08-140'], finish: 'normal' },
  { name: 'Snorlax', number: '063/088', expected: ['me03-063'], finish: 'normal' },
  { name: 'Doublade', number: '057/088', expected: ['me03-057'], finish: 'normal' },
  { name: 'Dedenne', number: '029/088', expected: ['me03-029'], finish: 'normal' },
  { name: 'Terapagos', number: '161/191', expected: ['sv08-161'], finish: 'holo' },
  { name: 'Gouging Fire', number: '038/191', expected: ['sv08-038'], finish: 'holo', note: 'printed wood-grain body texture' },
  { name: 'Telepathic Energy', number: '088/088', expected: ['me03-088'], finish: 'holo', note: 'energy layout, no body margins' },
  { name: 'Chien-Pao', number: '054/088', expected: ['me03-054'], finish: 'holo' },
  { name: 'Poké Ball', number: '080/088', expected: ['me03-080'], finish: 'reverse', note: 'trainer layout' },
  { name: 'Charcadet', number: '032/191', expected: ['sv08-032'], finish: 'reverse', note: 'patterned reverse' },
  { name: 'Cetoddle', number: '053/191', expected: ['sv08-053'], finish: 'reverse', note: 'patterned reverse' },
  { name: 'Koraidon', number: '116/191', expected: ['sv08-116'], finish: 'reverse' },
  { name: 'Luxio', number: '027/088', expected: ['me03-027'], finish: 'reverse' },
  { name: 'Diggersby', number: '065/088', expected: ['me03-065'], finish: 'reverse' },
  { name: 'Clefairy', number: '094/088', expected: ['me03-094'], finish: 'holo', note: 'full art' },
  { name: 'Mega Scrafty ex (JP)', number: '110/193', expected: ['ja:M2a-110'], finish: 'holo', note: 'Japanese, full art' },
  { name: 'Mega Manectric ex (JP)', number: '077/063', expected: ['ja:M1S-077', 'ja:M1L-077'], finish: 'holo', note: 'Japanese, full art' },
]

export const BENCH_ATTEMPTS = 5
