import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate } from 'react-router-dom'
import { BookOpen, Search, Plus, Sparkles, Ban, X } from 'lucide-react'
import { db } from '../data/db'
import type { Artist, ArtistStatus } from '../data/types'
import { assignPage, upsertArtistByName } from '../store/collection'
import { useSettings } from '../store/settings'
import { CardImage, Fav, Segmented, Sheet, StatusChip, Title, TitleBar, toast } from '../components/ui'

type View = 'pages' | 'collecting' | 'not-collecting' | 'unknown'

export default function Binder() {
  const nav = useNavigate()
  const [view, setView] = useState<View>('pages')
  const [q, setQ] = useState('')
  const [assign, setAssign] = useState<number | null>(null)
  const capacity = useSettings((s) => s.pageCapacity)

  const pages = useLiveQuery(() => db.binderPages.orderBy('page').toArray(), [])
  const artists = useLiveQuery(() => db.artists.toArray(), [])
  const owned = useLiveQuery(() => db.owned.filter((o) => !o.deleted).toArray(), [])
  const cards = useLiveQuery(() => db.cards.toArray(), [])

  const artistMap = useMemo(() => new Map((artists ?? []).map((a) => [a.key, a])), [artists])
  // cards owned per artist key (collection bucket only) + a cover image
  const perArtist = useMemo(() => {
    const cardMap = new Map((cards ?? []).map((c) => [c.id, c]))
    const m = new Map<string, { count: number; cover: string | null }>()
    for (const o of owned ?? []) {
      const c = cardMap.get(o.cardId)
      if (!c?.illustrator || o.bucket !== 'collection') continue
      const k = c.illustrator.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[’'`]/g, '')
      const e = m.get(k) ?? { count: 0, cover: null }
      e.count += o.qty
      e.cover ??= c.image ?? null
      m.set(k, e)
    }
    return m
  }, [owned, cards])

  const counts = useMemo(() => {
    const c: Record<ArtistStatus, number> = { collecting: 0, 'not-collecting': 0, unknown: 0 }
    for (const a of artists ?? []) c[a.status]++
    return c
  }, [artists])

  const needle = q.trim().toLowerCase()
  const list = useMemo(() => {
    if (view === 'pages') return []
    return (artists ?? [])
      .filter((a) => a.status === view && (!needle || a.name.toLowerCase().includes(needle) || a.style?.toLowerCase().includes(needle) || a.reason?.toLowerCase().includes(needle)))
      .sort((a, b) => (a.favourite ?? 9) - (b.favourite ?? 9) || a.name.localeCompare(b.name))
  }, [artists, view, needle])

  const filled = (pages ?? []).filter((p) => p.artistKey).length

  return (
    <div className="screen">
      <TitleBar actions={view === 'pages' ? <span className="chip chip--outline" style={{ height: 32, fontSize: 'var(--fs-sm)' }}>{filled}/{pages?.length ?? 0}</span> : undefined}>
        <Title icon={<BookOpen size={20} strokeWidth={3} />}>Binder</Title>
      </TitleBar>

      <div className="stack" style={{ marginBottom: 20 }}>
        <div style={{ overflowX: 'auto', margin: '0 -16px', padding: '0 16px' }}>
          <Segmented
            value={view}
            onChange={setView}
            options={[
              { value: 'pages', label: 'Pages' },
              { value: 'collecting', label: 'Collecting', count: counts.collecting },
              { value: 'unknown', label: 'New', count: counts.unknown, icon: <Sparkles size={14} /> },
              { value: 'not-collecting', label: 'Skip', count: counts['not-collecting'], icon: <Ban size={14} /> },
            ]}
          />
        </div>
        {view !== 'pages' && (
          <div className="search">
            <Search className="search__icon" size={18} />
            <input className="input" placeholder="Search artists" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        )}
      </div>

      {view === 'pages' ? (
        <div className="binder">
          {(pages ?? []).map((p) => {
            const a = p.artistKey ? artistMap.get(p.artistKey) : undefined
            const stats = a ? perArtist.get(a.key) : undefined
            const n = stats?.count ?? 0
            const pct = Math.min(100, (n / capacity) * 100)
            if (!a) {
              return (
                <button key={p.page} className="page page--empty" onClick={() => setAssign(p.page)}>
                  <div className="page__num">PAGE <b>{p.page}</b></div>
                  <div className="page__plus"><Plus size={28} /></div>
                </button>
              )
            }
            return (
              <button key={p.page} className="page" onClick={() => nav(`/artist/${encodeURIComponent(a.key)}`)}>
                <div className="row row--between">
                  <div className="page__num">PAGE <b>{p.page}</b></div>
                  <Fav rank={a.favourite} />
                </div>
                {stats?.cover && <div className="page__fan"><CardImage src={stats.cover} /></div>}
                <div>
                  <div className="page__name">{a.name}</div>
                  {a.style && <div className="page__style">{a.style}</div>}
                  <div className="page__fill"><i className={n > capacity ? 'over' : ''} style={{ width: `${pct}%` }} /></div>
                  <div className="page__meta"><span>{n} / {capacity}</span>{n > capacity && <span style={{ color: 'var(--value)' }}>+{n - capacity}</span>}</div>
                </div>
              </button>
            )
          })}
        </div>
      ) : (
        <div className="list">
          {list.length === 0 && <div className="empty">—</div>}
          {list.map((a) => <ArtistRow key={a.key} a={a} count={perArtist.get(a.key)?.count ?? 0} onClick={() => nav(`/artist/${encodeURIComponent(a.key)}`)} />)}
        </div>
      )}

      <AssignSheet page={assign} onClose={() => setAssign(null)} artists={artists ?? []} />
    </div>
  )
}

export function ArtistRow({ a, count, onClick }: { a: Artist; count: number; onClick: () => void }) {
  return (
    <button className="list__item" onClick={onClick}>
      <div className="list__grow">
        <div className="list__title">{a.name}</div>
        <div className="list__sub">{a.status === 'collecting' ? (a.style ?? '') : a.status === 'not-collecting' ? (a.reason ?? '') : 'Look up'}</div>
      </div>
      {a.binderPage && <span className="chip chip--outline">P{a.binderPage}</span>}
      {count > 0 && <span className="chip">{count}</span>}
      {a.status === 'collecting' ? <Fav rank={a.favourite} /> : <StatusChip status={a.status} />}
    </button>
  )
}

/** Pick an artist for an empty page: unplaced collecting artists first, then new, then anyone. */
export function AssignSheet({ page, onClose, artists }: { page: number | null; onClose: () => void; artists: Artist[] }) {
  const [q, setQ] = useState('')
  const needle = q.trim().toLowerCase()
  const candidates = useMemo(() => {
    const rank = (a: Artist) => (a.status === 'collecting' && !a.binderPage ? 0 : a.status === 'unknown' ? 1 : a.status === 'collecting' ? 2 : 3)
    return artists
      .filter((a) => !needle || a.name.toLowerCase().includes(needle))
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
      .slice(0, 60)
  }, [artists, needle])
  const pick = async (key: string) => {
    if (page == null) return
    await assignPage(page, key)
    toast(`Page ${page}`)
    onClose()
  }
  const createNew = async () => {
    if (!q.trim() || page == null) return
    const a = await upsertArtistByName(q.trim(), 'collecting')
    await assignPage(page, a.key)
    toast(`Page ${page}`)
    onClose()
  }
  return (
    <Sheet open={page != null} onClose={onClose}>
      <div className="stack">
        <div className="row row--between">
          <Title small>Page {page}</Title>
          <button className="iconbtn iconbtn--ghost" onClick={onClose}><X /></button>
        </div>
        <div className="search">
          <Search className="search__icon" size={18} />
          <input className="input" autoFocus placeholder="Artist" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="list">
          {q.trim() && !artists.some((a) => a.name.toLowerCase() === needle) && (
            <button className="list__item" onClick={createNew}><Plus size={18} color="var(--accent)" /><div className="list__grow"><div className="list__title">{q.trim()}</div><div className="list__sub">New artist</div></div></button>
          )}
          {candidates.map((a) => (
            <button key={a.key} className="list__item" onClick={() => pick(a.key)}>
              <div className="list__grow"><div className="list__title">{a.name}</div><div className="list__sub">{a.style ?? a.reason ?? ''}</div></div>
              {a.binderPage && <span className="chip chip--outline">P{a.binderPage}</span>}
              <StatusChip status={a.status} />
            </button>
          ))}
        </div>
      </div>
    </Sheet>
  )
}
