import { logEvent } from '../utils/perfLog'
import { db, getMeta, setMeta } from '../data/db'
import { setCode, type CardRecord, type IndexEntry, type SetInfo, type Finish } from '../data/types'

const API = 'https://api.tcgdex.net/v2/en'
const API_JA = 'https://api.tcgdex.net/v2/ja'
const INDEX_TTL = 7 * 86_400_000
const PRICE_TTL = 86_400_000
const INDEX_KEY = 'cardIndex:v3' // bump when the index shape or filters change (v3: Japanese catalogue)
const CARD_SCHEMA = 2            // bump when a cached card record's derived fields change meaning

/** Japanese prints live in the catalogue under a "ja:" prefix; the API id is the rest. */
export const isJa = (id: string) => id.startsWith('ja:')
const apiId = (id: string) => (isJa(id) ? id.slice(3) : id)
const apiFor = (id: string) => (isJa(id) ? API_JA : API)

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
    void fillSetCodes(indexCache)
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
    // Japanese prints: the set code (M2a, SV8a) is printed beside the number and is what
    // tells a Japanese card from the English card with the same number. Without the
    // Japanese catalogue the app can only ever land on the English look-alike.
    try {
      const [jc, js] = await Promise.all([fetch(`${API_JA}/cards`), fetch(`${API_JA}/sets`)])
      const jcards: any[] = await jc.json()
      const jsets: any[] = await js.json()
      for (const s of jsets) {
        sets[`ja:${s.id}`] = { id: `ja:${s.id}`, name: s.name, total: s.cardCount?.official ?? 0, totalAll: s.cardCount?.total ?? 0, lang: 'ja' }
      }
      for (const c of jcards) {
        const setId = `ja:${c.id.slice(0, c.id.lastIndexOf('-'))}`
        entries.push({ id: `ja:${c.id}`, n: normNumber(c.localId), name: c.name, set: setId, total: sets[setId]?.total ?? 0, img: c.image ?? null, lang: 'ja' })
      }
    } catch { /* the English catalogue alone is still useful */ }
    indexCache = { entries, sets }
    await setMeta(INDEX_KEY, indexCache)
    void fillSetCodes(indexCache)
    return indexCache
  } catch (e) {
    if (stored) { indexCache = stored.value; void fillSetCodes(indexCache); return indexCache }
    throw e
  }
}

/**
 * The code printed beside the number (SSP, MEE, POR) lives only in each set's own record,
 * not in the list the index is built from. Cards print it from Scarlet & Violet on, so
 * those sets are looked up once in the background and the codes kept; the search and the
 * matcher read them from the index. Japanese set ids already are the printed code.
 */
const ABBR_KEY = 'setAbbr:v1'
let fillingCodes: Promise<void> | null = null
function fillSetCodes(idx: { sets: Record<string, SetInfo> }): Promise<void> {
  if (fillingCodes) return fillingCodes
  fillingCodes = (async () => {
    const stored = await getMeta<Record<string, string>>(ABBR_KEY)
    const known: Record<string, string> = stored?.value ?? {}
    for (const [id, code] of Object.entries(known)) if (code && idx.sets[id]) idx.sets[id].code = code
    const missing = Object.keys(idx.sets).filter((id) => /^(sv|me)/.test(id) && !(id in known))
    if (!missing.length || !navigator.onLine) return
    for (let i = 0; i < missing.length; i += 6) {
      await Promise.all(missing.slice(i, i + 6).map(async (id) => {
        try {
          const r = await fetch(`${API}/sets/${encodeURIComponent(id)}`)
          if (!r.ok) return
          const d = await r.json()
          const code = typeof d.abbreviation?.official === 'string' ? d.abbreviation.official : ''
          known[id] = code
          if (code) idx.sets[id].code = code
        } catch { /* the next load tries again */ }
      }))
    }
    await setMeta(ABBR_KEY, known)
  })().finally(() => { fillingCodes = null })
  return fillingCodes
}

/** The code shown for a set: the printed abbreviation when known (SSP), else the set id (SV08, M2a). */
export const printedCode = (setId: string) => indexCache?.sets[setId]?.code ?? setCode(setId)

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
  const tcgFinishes = new Set<Finish>()
  for (const v of variants) {
    const vType: string = typeof v.type === 'string' ? v.type : ''
    const tp = v.pricing?.tcgplayer
    if (tp) {
      for (const [k, val] of Object.entries<any>(tp)) {
        if (k === 'unit' || k === 'updated' || !val || typeof val !== 'object') continue
        const m = val.marketPrice ?? val.midPrice
        if (typeof m === 'number' && m > 0 && m < 50_000) {
          usd = Math.max(usd ?? 0, m)
          const f = finishOf(k) ?? finishOf(vType)
          if (f) tcgFinishes.add(f)
          bump(f, m, null)
        }
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
  // Cardmarket prices every variant type the database lists, including a "normal" print a
  // holo rare never had; TCGplayer only lists prints that exist. When TCGplayer has spoken,
  // only its finishes count (keeping any euro prices for them).
  if (tcgFinishes.size) for (const k of Object.keys(variantPrices) as Finish[]) if (!tcgFinishes.has(k)) delete variantPrices[k]
  return { usd, eur, tcgplayerId, cardmarketId, variantPrices: Object.keys(variantPrices).length ? variantPrices : null }
}

/**
 * `quick` is for the scan path: a cached record is returned at once however old it is
 * (prices refresh in the background), and a fetch that is needed gets 5 s before the
 * scan goes on without it. Slow mobile data must never hold a scan for half a minute.
 */
/**
 * English name for a Japanese card: the Pokédex number maps to the English catalogue
 * ("メガズルズキンex" → "Mega Scrafty ex"). Trainers and energies keep their printed name.
 */
const dexNames = new Map<number, string>()
async function englishName(d: any): Promise<string | null> {
  const dex: number | undefined = Array.isArray(d.dexId) ? d.dexId[0] : undefined
  if (!dex) return null
  let base = dexNames.get(dex)
  if (!base) {
    const stored = await getMeta<string>(`dexName:${dex}`)
    if (stored) base = stored.value
    else {
      try {
        const r = await fetch(`${API}/cards?dexId=${dex}`)
        const list: any[] = r.ok ? await r.json() : []
        const plain = list.map((c) => String(c.name)).find((n) => /^[A-Za-z' .-]+$/.test(n)) ?? list[0]?.name
        if (plain) { base = plain; await setMeta(`dexName:${dex}`, plain) }
      } catch { /* offline: keep the Japanese name */ }
    }
    if (base) dexNames.set(dex, base)
  }
  if (!base) return null
  const ja: string = d.name ?? ''
  const mega = /^メガ/.test(ja) ? 'Mega ' : ''
  const suffix = d.suffix ? ` ${String(d.suffix).toLowerCase() === 'ex' ? 'ex' : d.suffix}` : ''
  return `${mega}${base}${suffix}`
}

export async function getCard(id: string, opts: { refresh?: boolean; quick?: boolean } = {}): Promise<CardRecord> {
  const cached = await db.cards.get(id)
  // records cached before finishes were stored have no `variants` key: fetch them again
  // Records cached by an earlier build keep stale derived fields (a holo rare priced "normal"
  // by Cardmarket): a schema bump refetches them once.
  const fresh = cached && cached.pricesUpdatedAt && Date.now() - cached.pricesUpdatedAt < PRICE_TTL && cached.variants !== undefined && cached.schema === CARD_SCHEMA
  if (cached && fresh && !opts.refresh) return cached
  if (cached && opts.quick && cached.variants !== undefined && (cached.schema === CARD_SCHEMA || !navigator.onLine)) {
    void getCard(id).catch(() => {})
    return cached
  }
  try {
    const t0 = performance.now()
    const ctl = opts.quick ? new AbortController() : null
    const timer = ctl ? setTimeout(() => ctl.abort(), 5000) : null
    const r = await fetch(`${apiFor(id)}/cards/${encodeURIComponent(apiId(id))}`, ctl ? { signal: ctl.signal } : undefined).finally(() => { if (timer) clearTimeout(timer) })
    if (!r.ok) throw new Error(`card ${id}: ${r.status}`)
    const d = await r.json()
    logEvent('net', `card ${id}`, performance.now() - t0)
    const p = parsePrices(d)
    const ja = isJa(id)
    const en = ja ? await englishName(d) : null
    const rec: CardRecord = {
      id,
      name: en ?? d.name,
      ...(ja && en ? { nameJa: d.name } : {}),
      localId: d.localId,
      setId: (ja ? 'ja:' : '') + (d.set?.id ?? apiId(id).slice(0, apiId(id).lastIndexOf('-'))),
      ...(ja ? { lang: 'ja' as const } : {}),
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
      schema: CARD_SCHEMA,
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
