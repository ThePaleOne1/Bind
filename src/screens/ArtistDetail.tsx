import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate, useParams } from 'react-router-dom'
import { ChevronLeft, ExternalLink, BookOpen, Palette } from 'lucide-react'
import { db, BINDER_PAGES } from '../data/db'
import type { ArtistStatus } from '../data/types'
import { assignPage, setArtistStatus, updateArtist } from '../store/collection'
import { artofpkmUrl } from '../utils/links'
import { TileTags, CardImage, Segmented, Sheet, Title, TitleBar, toast } from '../components/ui'
import { CardDetailSheet } from '../components/CardDetail'

export default function ArtistDetail() {
  const { key = '' } = useParams()
  const k = decodeURIComponent(key)
  const nav = useNavigate()
  const artist = useLiveQuery(() => db.artists.get(k), [k])
  const cards = useLiveQuery(() => (artist ? db.cards.where('illustrator').equals(artist.name).toArray() : []), [artist?.name])
  const owned = useLiveQuery(() => db.owned.filter((o) => !o.deleted).toArray(), [])
  const pages = useLiveQuery(() => db.binderPages.toArray(), [])
  const [open, setOpen] = useState<string | null>(null)
  const [pagePick, setPagePick] = useState(false)
  const [notes, setNotes] = useState(false)

  const ownedCards = useMemo(() => {
    const ids = new Set((cards ?? []).map((c) => c.id))
    const map = new Map((cards ?? []).map((c) => [c.id, c]))
    return (owned ?? []).filter((o) => ids.has(o.cardId)).map((o) => ({ o, c: map.get(o.cardId)! }))
  }, [cards, owned])

  if (!artist) return <div className="screen"><div className="empty">—</div></div>

  const tone = artist.status === 'collecting' ? 'accent' : artist.status === 'unknown' ? 'new' : 'grey'
  const total = ownedCards.reduce((s, x) => s + x.o.qty, 0)

  const change = async (s: ArtistStatus) => {
    await setArtistStatus(k, s)
    if (s === 'collecting' && !artist.binderPage) setPagePick(true)
  }

  return (
    <div className="screen">
      <TitleBar actions={
        <a className="iconbtn" href={artofpkmUrl(artist.name)} target="_blank" rel="noreferrer" aria-label="Art of PKM"><ExternalLink size={20} /></a>
      }>
        <div className="row">
          <button className="iconbtn iconbtn--ghost" onClick={() => nav(-1)} aria-label="Back"><ChevronLeft /></button>
          <Title tone={tone} icon={<Palette size={20} strokeWidth={3} />}>{artist.name}</Title>
        </div>
      </TitleBar>

      <div className="stack" style={{ gap: 18 }}>
        <Segmented
          value={artist.status}
          onChange={change}
          options={[{ value: 'collecting', label: 'Collect' }, { value: 'unknown', label: 'New' }, { value: 'not-collecting', label: 'Skip' }]}
        />

        <div className="detail__facts">
          <button className="fact" onClick={() => setPagePick(true)} style={{ textAlign: 'left' }}>
            <div className="label">Page</div>
            <div className="fact__v row" style={{ gap: 6 }}><BookOpen size={16} /> {artist.binderPage ?? '—'}</div>
          </button>
          <div className="fact"><div className="label">Owned</div><div className="fact__v">{total}</div></div>
          {artist.status === 'collecting' && (
            <button className="fact" style={{ textAlign: 'left' }} onClick={() => setNotes(true)}>
              <div className="label">Favourite</div>
              <div className="fact__v">{artist.favourite ? `#${artist.favourite}` : '—'}</div>
            </button>
          )}
          <button className="fact fact--wide" style={{ textAlign: 'left' }} onClick={() => setNotes(true)}>
            <div className="label">{artist.status === 'not-collecting' ? 'Reason' : 'Style'}</div>
            <div className="fact__v" style={{ fontSize: 'var(--fs-md)', whiteSpace: 'normal' }}>{(artist.status === 'not-collecting' ? artist.reason : artist.style) ?? '—'}</div>
          </button>
        </div>

        {ownedCards.length > 0 ? (
          <div className="grid">
            {ownedCards.map(({ o, c }) => (
              <button key={o.id} className="tile" onClick={() => setOpen(c.id)}>
                <CardImage src={c.image} alt={c.name} />
                <TileTags finish={o.finish} rarity={c.rarity} />
                {o.qty > 1 && <span className="tile__qty">×{o.qty}</span>}
                {o.bucket === 'bulk' && <span className="tile__price" style={{ color: 'var(--muted)' }}>bulk</span>}
              </button>
            ))}
          </div>
        ) : (
          <div className="empty"><div className="muted">No cards yet</div></div>
        )}
      </div>

      {/* page picker */}
      <Sheet open={pagePick} onClose={() => setPagePick(false)}>
        <div className="stack">
          <Title small>Page</Title>
          <div className="binder" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(64px, 1fr))' }}>
            {Array.from({ length: BINDER_PAGES }, (_, i) => i + 1).map((p) => {
              const taken = pages?.find((x) => x.page === p)?.artistKey
              const mine = taken === k
              return (
                <button
                  key={p}
                  className={`page ${!taken ? 'page--empty' : ''}`}
                  style={{ aspectRatio: '1', padding: 8, justifyContent: 'center', alignItems: 'center', borderColor: mine ? 'var(--accent)' : undefined, opacity: taken && !mine ? 0.4 : 1 }}
                  onClick={async () => { await assignPage(p, k); setPagePick(false); toast(`Page ${p}`) }}
                >
                  <b style={{ fontSize: 'var(--fs-lg)' }}>{p}</b>
                </button>
              )
            })}
          </div>
          {artist.binderPage && (
            <button className="btn btn--ghost" onClick={async () => { await assignPage(artist.binderPage!, null); setPagePick(false) }}>Clear page</button>
          )}
        </div>
      </Sheet>

      {/* notes */}
      <Sheet open={notes} onClose={() => setNotes(false)}>
        <div className="stack">
          <Title small>{artist.name}</Title>
          <label className="label">Style</label>
          <input className="input" defaultValue={artist.style ?? ''} onBlur={(e) => updateArtist(k, { style: e.target.value || null })} placeholder="Clean, Texture" />
          <label className="label">Reason</label>
          <input className="input" defaultValue={artist.reason ?? ''} onBlur={(e) => updateArtist(k, { reason: e.target.value || null })} placeholder="Too many cards" />
          <label className="label">Favourite</label>
          <Segmented
            value={String(artist.favourite ?? 0)}
            onChange={(v) => updateArtist(k, { favourite: v === '0' ? null : Number(v) })}
            options={[{ value: '1', label: '1' }, { value: '2', label: '2' }, { value: '3', label: '3' }, { value: '4', label: '4' }, { value: '0', label: '—' }]}
          />
          <label className="label">Note</label>
          <input className="input" defaultValue={artist.note ?? ''} onBlur={(e) => updateArtist(k, { note: e.target.value || null })} />
        </div>
      </Sheet>

      <CardDetailSheet cardId={open} onClose={() => setOpen(null)} />
    </div>
  )
}
