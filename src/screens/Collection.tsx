import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate } from 'react-router-dom'
import { ArrowDownUp, Search, LayoutGrid } from 'lucide-react'
import { db } from '../data/db'
import type { Bucket, CardRecord, OwnedCard } from '../data/types'
import { artistKey } from '../data/types'
import { getCard } from '../api/tcgdex'
import { getRates, toAud, fmtAud, type Rates } from '../utils/price'
import { useSettings } from '../store/settings'
import { CardImage, Segmented, StatusChip, Title, TitleBar } from '../components/ui'
import { CardDetailSheet } from '../components/CardDetail'

type Sort = 'artist' | 'recent' | 'value' | 'set'

export default function Collection() {
  const nav = useNavigate()
  const [bucket, setBucket] = useState<Bucket>('collection')
  const [sort, setSort] = useState<Sort>('artist')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [rates, setRates] = useState<Rates | null>(null)
  const threshold = useSettings((s) => s.highValueAud)
  useEffect(() => { void getRates().then(setRates) }, [])

  const owned = useLiveQuery(() => db.owned.filter((o) => !o.deleted).toArray(), [])
  const cards = useLiveQuery(() => db.cards.toArray(), [])
  const artists = useLiveQuery(() => db.artists.toArray(), [])
  const cardMap = useMemo(() => new Map((cards ?? []).map((c) => [c.id, c])), [cards])
  const artistMap = useMemo(() => new Map((artists ?? []).map((a) => [a.key, a])), [artists])

  // make sure every owned card has its details cached
  useEffect(() => {
    if (!owned) return
    for (const o of owned) if (!cardMap.has(o.cardId)) void getCard(o.cardId).catch(() => {})
  }, [owned, cardMap])

  const counts = useMemo(() => {
    const c = { collection: 0, bulk: 0 }
    for (const o of owned ?? []) c[o.bucket] += o.qty
    return c
  }, [owned])

  const items = useMemo(() => {
    const list = (owned ?? [])
      .filter((o) => o.bucket === bucket)
      .map((o) => ({ o, c: cardMap.get(o.cardId) }))
      .filter((x): x is { o: OwnedCard; c: CardRecord } => !!x.c)
      .map((x) => ({ ...x, v: rates ? toAud(x.c.priceUsd, x.c.priceEur, rates) : null }))
    const needle = q.trim().toLowerCase()
    const filtered = needle
      ? list.filter((x) => x.c.name.toLowerCase().includes(needle) || x.c.illustrator?.toLowerCase().includes(needle) || x.c.setName.toLowerCase().includes(needle))
      : list
    const total = filtered.reduce((s, x) => s + (x.v ?? 0) * x.o.qty, 0)
    switch (sort) {
      case 'recent': filtered.sort((a, b) => b.o.addedAt - a.o.addedAt); break
      case 'value': filtered.sort((a, b) => (b.v ?? 0) - (a.v ?? 0)); break
      case 'set': filtered.sort((a, b) => a.c.setName.localeCompare(b.c.setName) || a.c.localId.localeCompare(b.c.localId, undefined, { numeric: true })); break
      default: filtered.sort((a, b) => (a.c.illustrator ?? 'zz').localeCompare(b.c.illustrator ?? 'zz') || a.c.name.localeCompare(b.c.name))
    }
    return { filtered, total }
  }, [owned, cardMap, bucket, sort, q, rates])

  // Group by artist when sorting by artist
  const groups = useMemo(() => {
    if (sort !== 'artist') return null
    const g = new Map<string, typeof items.filtered>()
    for (const x of items.filtered) {
      const k = x.c.illustrator ?? 'Unknown artist'
      if (!g.has(k)) g.set(k, [])
      g.get(k)!.push(x)
    }
    return [...g.entries()]
  }, [items, sort])

  const Tile = ({ x }: { x: { o: OwnedCard; c: CardRecord; v: number | null } }) => (
    <button className="tile" onClick={() => setOpen(x.c.id)}>
      <CardImage src={x.c.image} alt={x.c.name} />
      {x.o.qty > 1 && <span className="tile__qty">×{x.o.qty}</span>}
      {x.v != null && <span className={`tile__price ${x.v >= threshold ? 'tile__price--hot' : ''}`}>{fmtAud(x.v)}</span>}
    </button>
  )

  return (
    <div className="screen">
      <TitleBar actions={<span className="chip chip--outline" style={{ height: 32, fontSize: 'var(--fs-sm)' }}>{fmtAud(items.total)}</span>}>
        <Title icon={<LayoutGrid size={20} strokeWidth={3} />} count={counts[bucket]}>Cards</Title>
      </TitleBar>

      <div className="stack" style={{ marginBottom: 20 }}>
        <div className="row row--between" style={{ flexWrap: 'wrap' }}>
          <Segmented value={bucket} onChange={setBucket} options={[{ value: 'collection', label: 'Collection', count: counts.collection }, { value: 'bulk', label: 'Bulk', count: counts.bulk }]} />
          <div className="seg">
            {(['artist', 'recent', 'value', 'set'] as Sort[]).map((s) => (
              <button key={s} className={`seg__btn ${sort === s ? 'seg__btn--on' : ''}`} style={{ padding: '0 10px' }} onClick={() => setSort(s)}>
                {sort === s && <span className="seg__thumb" />}
                <span style={{ position: 'relative', zIndex: 1 }}>{s === 'artist' ? <ArrowDownUp size={14} /> : null} {s}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="search">
          <Search className="search__icon" size={18} />
          <input className="input" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>

      {items.filtered.length === 0 ? (
        <div className="empty">
          <LayoutGrid size={44} />
          <div className="big" style={{ color: 'var(--text-2)' }}>{bucket === 'collection' ? 'Nothing here yet' : 'No bulk'}</div>
          <button className="btn btn--accent" onClick={() => nav('/scan')}>Scan</button>
        </div>
      ) : groups ? (
        groups.map(([artist, list]) => {
          const a = artistMap.get(artistKey(artist))
          const sum = list.reduce((s, x) => s + (x.v ?? 0) * x.o.qty, 0)
          return (
            <section className="section" key={artist}>
              <div className="section__head">
                <button className="row" onClick={() => a && nav(`/artist/${encodeURIComponent(a.key)}`)} style={{ textAlign: 'left', minWidth: 0 }}>
                  <span className="title title--sm" style={{ background: 'var(--surface-3)', color: 'var(--text)', boxShadow: 'none' }}>{artist}</span>
                  {a && <StatusChip status={a.status} />}
                </button>
                <span className="muted" style={{ fontWeight: 800, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{list.reduce((s, x) => s + x.o.qty, 0)} · {fmtAud(sum)}</span>
              </div>
              <div className="grid">{list.map((x) => <Tile key={x.o.id} x={x} />)}</div>
            </section>
          )
        })
      ) : (
        <div className="grid">{items.filtered.map((x) => <Tile key={x.o.id} x={x} />)}</div>
      )}

      <CardDetailSheet cardId={open} onClose={() => setOpen(null)} />
    </div>
  )
}
