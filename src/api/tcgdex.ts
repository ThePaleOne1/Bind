import { logEvent } from '../utils/perfLog'
import { db, getMeta, setMeta } from '../data/db'
import type {CardRecord, IndexEntry, SetInfo, Finish } from '../data/types'

const API = 'https://api.tcgdex.net/v2/en'
const INDEX_TTL = 7 * 86_400_000
const PRICE_TTL = 86_400_000
const INDEX_KEY = 'cardIndex:v2' // bump when the index shape or filters change

/** "025" -> "25", "TG01" -> "TG1", "SWSH001" -> "SWSH1" */
export const normNumber = (n: string) =>
  decodeURIComponent(n).toUpperCase().replace(/\s+/g, '').replace(/^([A-Z]*)0+(\d)/, '$1$2')

export const imageUrl = (base: string | null | undefined, q: 'low' | 'high' = 'low') =>
  base ? `${base}/${q}.webp` : null

let indexCache: { entries: IndexEntry[]; sets: Record<string, SetInfo> } | null = null

export async function loadIndex(force = false) {
  if (indexCache && !force) return indexCache
  const stored = await getMeta<{ entries: IndexEntry[]; sets: Record<string, SetInfo> }>(INDEX_KEY)
  if (stored && !force && Date.now() - stored.at < INDEX_TTL) {
    indexCache = stored.value
    return indexCache
  }
  try {
    const [cardsRes, setsRes] = await Promise.all([fetch(`${API}/cards`), fetch(`${API}/sets`)])
    const cards: any[] = await cardsRes.json()
    const setsArr: any[] = await setsRes.json()
    const sets: Record<string, SetInfo> = {}
    for (const s of setsArr) {
      sets[s.id] = { id: s.id, name: s.name, total: s.cardCount?.official ?? 0, totalAll: s.cardCount?.total ?? 0 }
    }
    const entries: IndexEntry[] = cards
      .filter((c) => !c.image?.includes('/tcgp/') && !/^(A\d|B\d|P)[a-z]?-/.test(c.id)) // drop TCG Pocket (digital only)
      .map((c) => {
        const setId = c.id.slice(0, c.id.lastIndexOf('-'))
        return { id: c.id, n: normNumber(c.localId), name: c.name, set: setId, total: sets[setId]?.total ?? 0, img: c.image ?? null }
      })
    indexCache = { entries, sets }
    await setMeta(INDEX_KEY, indexCache)
    return indexCache
  } catch (e) {
    if (stored) { indexCache = stored.value; return indexCache }
    throw e
  }
}

export async function indexStatus() {
  const stored = await getMeta<{ entries: IndexEntry[] }>(INDEX_KEY)
  return stored ? { count: stored.value.entries.length, at: stored.at } : null
}

/** TCGplayer price keys and TCGdex variant types → finish. */
const finishOf = (key: string): Finish | null => {
  const k = key.toLowerCase()
  if (k.includes('1st') || k.includes('first')) return 'first-edition'
  if (k.includes('reverse')) return 'reverse'
  if (k.includes('holo')) return 'holo'
  if (k === 'normal' || k === 'unlimited') return 'normal'
  return null
}

function parsePrices(detail: any) {
  let usd: number | null = null
  let eur: number | null = null
  let tcgplayerId: number | null = null
  let cardmarketId: number | null = null
  const variantPrices: NonNullable<CardRecord['variantPrices']> = {}
  const bump = (f: Finish | null, usdV: number | null, eurV: number | null) => {
    if (!f) return
    const cur = variantPrices[f] ?? { usd: null, eur: null }
    if (usdV != null) cur.usd = Math.max(cur.usd ?? 0, usdV)
    if (eurV != null) cur.eur = Math.max(cur.eur ?? 0, eurV)
    variantPrices[f] = cur
  }
  const variants: any[] = detail.variants_detailed ?? []
  for (const v of variants) {
    const vType: string = typeof v.type === 'string' ? v.type : ''
    const tp = v.pricing?.tcgplayer
    if (tp) {
      for (const [k, val] of Object.entries<any>(tp)) {
        if (k === 'unit' || k === 'updated' || !val || typeof val !== 'object') continue
        const m = val.marketPrice ?? val.midPrice
        if (typeof m === 'number' && m > 0 && m < 50_000) { usd = Math.max(usd ?? 0, m); bump(finishOf(k) ?? finishOf(vType), m, null) }
        if (val.productId) tcgplayerId ??= val.productId
      }
    }
    const cm = v.pricing?.cardmarket
    if (cm) {
      const m = cm.trend ?? cm.avg7 ?? cm.avg
      if (typeof m === 'number' && m > 0) { eur = Math.max(eur ?? 0, m); bump(finishOf(vType), null, m) }
      if (cm.idProduct) cardmarketId ??= cm.idProduct
    }
    if (!tcgplayerId && v.thirdParty?.tcgplayer) tcgplayerId = v.thirdParty.tcgplayer
    if (!cardmarketId && v.thirdParty?.cardmarket) cardmarketId = v.thirdParty.cardmarket
  }
  // legacy top-level pricing shape
  const lp = detail.pricing
  if (lp?.tcgplayer && usd == null) {
    for (const val of Object.values<any>(lp.tcgplayer)) {
      if (val && typeof val === 'object' && typeof val.marketPrice === 'number') usd = Math.max(usd ?? 0, val.marketPrice)
    }
  }
  if (lp?.cardmarket && eur == null && typeof lp.cardmarket.trend === 'number') eur = lp.cardmarket.trend
  return { usd, eur, tcgplayerId, cardmarketId, variantPrices: Object.keys(variantPrices).length ? variantPrices : null }
}

/**
 * `quick` is for the scan path: a cached record is returned at once however old it is
 * (prices refresh in the background), and a fetch that is needed gets 5 s before the
 * scan goes on without it. Slow mobile data must never hold a scan for half a minute.
 */
export async function getCard(id: string, opts: { refresh?: boolean; quick?: boolean } = {}): Promise<CardRecord> {
  const cached = await db.cards.get(id)
  // records cached before finishes were stored have no `variants` key: fetch them again
  const fresh = cached && cached.pricesUpdatedAt && Date.now() - cached.pricesUpdatedAt < PRICE_TTL && cached.variants !== undefined
  if (cached && fresh && !opts.refresh) return cached
  if (cached && opts.quick && cached.variants !== undefined) {
    void getCard(id).catch(() => {})
    return cached
  }
  try {
    const t0 = performance.now()
    const ctl = opts.quick ? new AbortController() : null
    const timer = ctl ? setTimeout(() => ctl.abort(), 5000) : null
    const r = await fetch(`${API}/cards/${encodeURIComponent(id)}`, ctl ? { signal: ctl.signal } : undefined).finally(() => { if (timer) clearTimeout(timer) })
    if (!r.ok) throw new Error(`card ${id}: ${r.status}`)
    const d = await r.json()
    logEvent('net', `card ${id}`, performance.now() - t0)
    const p = parsePrices(d)
    const rec: CardRecord = {
      id: d.id,
      name: d.name,
      localId: d.localId,
      setId: d.set?.id ?? id.slice(0, id.lastIndexOf('-')),
      setName: d.set?.name ?? '',
      setTotal: d.set?.cardCount?.official ?? 0,
      image: d.image ?? null,
      illustrator: d.illustrator ?? null,
      rarity: d.rarity ?? null,
      category: d.category ?? null,
      variants: d.variants ? { normal: !!d.variants.normal, reverse: !!d.variants.reverse, holo: !!d.variants.holo, firstEdition: !!d.variants.firstEdition } : null,
      variantPrices: p.variantPrices,
      priceUsd: p.usd,
      priceEur: p.eur,
      tcgplayerId: p.tcgplayerId,
      cardmarketId: p.cardmarketId,
      pricesUpdatedAt: Date.now(),
      fetchedAt: Date.now(),
    }
    await db.cards.put(rec)
    return rec
  } catch (e) {
    if (cached) return cached
    throw e
  }
}

export async function getCards(ids: string[]) {
  return Promise.all(ids.map((id) => getCard(id)))
}

export const tcgplayerUrl = (c: CardRecord) =>
  c.tcgplayerId ? `https://www.tcgplayer.com/product/${c.tcgplayerId}` : `https://www.tcgplayer.com/search/pokemon/product?q=${encodeURIComponent(c.name + ' ' + c.localId)}`

export const cardmarketUrl = (c: CardRecord) =>
  `https://www.cardmarket.com/en/Pokemon/Products/Search?searchString=${encodeURIComponent(c.name + ' ' + c.localId)}`
