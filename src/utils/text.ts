/** Bigram Dice coefficient, 0..1 */
export function similarity(a: string, b: string): number {
  const na = norm(a), nb = norm(b)
  if (!na || !nb) return 0
  if (na === nb) return 1
  if (na.length < 2 || nb.length < 2) return 0
  const grams = new Map<string, number>()
  for (let i = 0; i < na.length - 1; i++) {
    const g = na.slice(i, i + 2)
    grams.set(g, (grams.get(g) ?? 0) + 1)
  }
  let hits = 0
  for (let i = 0; i < nb.length - 1; i++) {
    const g = nb.slice(i, i + 2)
    const c = grams.get(g) ?? 0
    if (c > 0) { grams.set(g, c - 1); hits++ }
  }
  return (2 * hits) / (na.length - 1 + nb.length - 1)
}

export const norm = (s: string) =>
  s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()

export const slugify = (s: string) =>
  s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
