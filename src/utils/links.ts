import slugs from '../data/artofpkmSlugs.json'
import { slugify, similarity } from './text'

const slugSet = new Set(slugs as string[])

/** Best-effort link to the artist's page on artofpkm.com; falls back to the index. */
export function artofpkmUrl(artistName: string): string {
  const s = slugify(artistName)
  if (slugSet.has(s)) return `https://www.artofpkm.com/illustrators/${s}`
  // try reversed order (e.g. "Saki Hasegawa" vs "hasegawa-saki")
  const parts = s.split('-')
  const rev = [...parts].reverse().join('-')
  if (slugSet.has(rev)) return `https://www.artofpkm.com/illustrators/${rev}`
  let best = ''
  let bestScore = 0
  for (const cand of slugSet) {
    const sc = similarity(cand.replace(/-/g, ' '), s.replace(/-/g, ' '))
    if (sc > bestScore) { bestScore = sc; best = cand }
  }
  if (bestScore >= 0.8) return `https://www.artofpkm.com/illustrators/${best}`
  return `https://www.artofpkm.com/illustrators`
}
