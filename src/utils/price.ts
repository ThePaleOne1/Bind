import { getMeta, setMeta } from '../data/db'

export interface Rates { AUD: number; EUR: number; at: number }
let cache: Rates | null = null

export async function getRates(): Promise<Rates> {
  if (cache && Date.now() - cache.at < 86_400_000) return cache
  const stored = await getMeta<Rates>('rates')
  if (stored && Date.now() - stored.value.at < 86_400_000) { cache = stored.value; return cache }
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/USD')
    const j = await r.json()
    cache = { AUD: j.rates.AUD, EUR: j.rates.EUR, at: Date.now() }
    await setMeta('rates', cache)
  } catch {
    cache = stored?.value ?? { AUD: 1.5, EUR: 0.92, at: Date.now() }
  }
  return cache
}

/** Best estimate in AUD from USD (TCGplayer market) or EUR (Cardmarket trend). */
export function toAud(usd: number | null | undefined, eur: number | null | undefined, rates: Rates): number | null {
  if (usd != null && usd > 0) return usd * rates.AUD
  if (eur != null && eur > 0) return (eur / rates.EUR) * rates.AUD
  return null
}

export const fmtAud = (v: number | null | undefined) =>
  v == null ? '—' : v >= 100 ? `$${Math.round(v)}` : `$${v.toFixed(2)}`
