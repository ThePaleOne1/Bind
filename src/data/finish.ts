import type { CardRecord, Finish } from './types'

export const FINISHES: Finish[] = ['normal', 'reverse', 'holo', 'first-edition']

export const FINISH_LABEL: Record<Finish, string> = {
  normal: 'Standard',
  reverse: 'Reverse holo',
  holo: 'Holo',
  'first-edition': '1st edition',
}

/** Short tile label; nothing for a standard print. */
export const finishTag = (f: Finish | undefined | null): string | null =>
  !f || f === 'normal' ? null : f === 'reverse' ? 'Reverse' : f === 'holo' ? 'Holo' : '1st ed.'

/**
 * The finishes this card was printed in, standard first.
 *
 * The database's variant flags are generous (a holo rare is often flagged "normal"
 * too); the market listings are not: a finish only gets a price when that print
 * exists. So when the card has per-finish prices, those are the finishes.
 */
export function finishesOf(card: Pick<CardRecord, 'variants' | 'variantPrices' | 'rarity' | 'setId'> | null | undefined): Finish[] {
  const priced = card?.variantPrices ? (Object.keys(card.variantPrices) as Finish[]).filter((f) => FINISHES.includes(f)) : []
  // Listings can miss the reverse of a card that has one (Koraidon 116/191 was offered holo
  // only); the database's reverse flag fills that gap. "normal" is never added back this way.
  if (priced.length) return FINISHES.filter((f) => priced.includes(f) || (f === 'reverse' && !!card?.variants?.reverse))
  const v = card?.variants
  if (!v) return ['normal']
  const out: Finish[] = []
  if (v.normal) out.push('normal')
  if (v.reverse) out.push('reverse')
  if (v.holo) out.push('holo')
  if (v.firstEdition) out.push('first-edition')
  // Without market data: from Scarlet & Violet on, a "Rare" (and anything rarer) is a
  // holo print; the flags still claim a standard one exists.
  const r = (card?.rarity ?? '').toLowerCase()
  const modern = /^(sv|me|ja:(sv|m))/i.test(card?.setId ?? '')
  const holoRarity = r === 'rare' || /holo|ultra|double|illustration|special|hyper|secret|ace|shiny|amazing|radiant/.test(r)
  if (modern && holoRarity && !r.includes('reverse') && out.includes('normal') && out.length > 1) return out.filter((f) => f !== 'normal')
  return out.length ? out : ['normal']
}

/**
 * What a freshly scanned copy most likely is. A card that only exists as a holo
 * (rares, full arts) is a holo; one that only exists as a reverse is a reverse;
 * anything with a standard print defaults to standard, and the user flips it.
 */
export function defaultFinish(card: Pick<CardRecord, 'variants' | 'variantPrices' | 'rarity' | 'setId'> | null | undefined): Finish {
  const f = finishesOf(card)
  return f.includes('normal') ? 'normal' : f[0]
}

/** Short tag for the rarities worth calling out on a tile; nothing for common/uncommon/rare. */
export function rarityTag(rarity: string | null | undefined): string | null {
  if (!rarity) return null
  const r = rarity.toLowerCase()
  if (r.includes('special illustration')) return 'SIR'
  if (r.includes('illustration')) return 'Illus. rare'
  if (r.includes('hyper') || r.includes('rainbow') || r.includes('secret')) return 'Secret'
  if (r.includes('ace spec')) return 'ACE SPEC'
  if (r.includes('ultra')) return 'Ultra'
  if (r.includes('double')) return 'Double rare'
  if (r.includes('shiny')) return 'Shiny'
  if (r.includes('amazing')) return 'Amazing'
  if (r.includes('radiant')) return 'Radiant'
  if (r.includes('holo') && !r.includes('reverse')) return 'Holo rare'
  if (r.includes('promo')) return 'Promo'
  return null
}

/** Market price for a specific finish when the database has one, else the card's headline price. */
export function priceFor(card: CardRecord, finish: Finish | undefined): { usd: number | null; eur: number | null } {
  const v = finish ? card.variantPrices?.[finish] : undefined
  return { usd: v?.usd ?? card.priceUsd ?? null, eur: v?.eur ?? card.priceEur ?? null }
}
