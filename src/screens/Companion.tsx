import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useLiveQuery } from 'dexie-react-hooks'
import { Monitor, ExternalLink, Palette, Wifi, WifiOff, Sparkles, Minus } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { db } from '../data/db'
import type { CardRecord, ScanEvent } from '../data/types'
import { getCard, tcgplayerUrl } from '../api/tcgdex'
import { useSettings } from '../store/settings'
import { onCompanion, companionConnected } from '../sync/companion'
import { useAuth } from '../sync/supabase'
import { artofpkmUrl } from '../utils/links'
import { fmtAud } from '../utils/price'
import { chime } from '../utils/haptics'
import { CardImage, STATUS_WORD, StatusChip, Title, TitleBar, toast } from '../components/ui'

/**
 * Desk view. Shows what the phone is scanning in real time and pops open the
 * relevant artist / price page. Also usable on the phone as a recent-scans log.
 */
export default function Companion() {
  const nav = useNavigate()
  const { autoOpenArtist, autoOpenPrice } = useSettings()
  const session = useAuth((s) => s.session)
  const [live, setLive] = useState<ScanEvent[]>([])
  const [hero, setHero] = useState<{ ev: ScanEvent; card: CardRecord | null } | null>(null)
  const [blocked, setBlocked] = useState<string | null>(null)
  const recent = useLiveQuery(() => db.scans.orderBy('at').reverse().limit(40).toArray(), [])
  const openedRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    return onCompanion(async (m) => {
      if (m.type !== 'scan' || !m.scan) return
      const ev = m.scan
      setLive((l) => [ev, ...l].slice(0, 60))
      let card: CardRecord | null = null
      try { card = await getCard(ev.cardId) } catch { /* offline */ }
      setHero({ ev, card })
      if (ev.action === 'remove') return
      // Decide what to open on the desk
      let url: string | null = null
      if (ev.highValue && autoOpenPrice && card) url = tcgplayerUrl(card)
      if (ev.artistStatus === 'unknown' && autoOpenArtist && ev.artist) {
        const key = `a:${ev.artist}`
        if (!openedRef.current.has(key)) { openedRef.current.add(key); url = artofpkmUrl(ev.artist) }
      }
      if (ev.highValue) chime('alert')
      if (url) {
        const w = window.open(url, 'bind-desk')
        if (!w) setBlocked(url)
      }
    })
  }, [autoOpenArtist, autoOpenPrice])

  const items = live.length ? live : (recent ?? [])
  const heroEv = hero?.ev ?? items[0]
  const connected = !!session && companionConnected()

  return (
    <div className="screen">
      <TitleBar actions={
        <span className={`chip ${connected ? 'chip--collecting' : 'chip--outline'}`} style={{ height: 32 }}>
          {connected ? <Wifi size={14} /> : <WifiOff size={14} />} {connected ? 'Linked' : session ? 'Linking' : 'Local'}
        </span>
      }>
        <Title icon={<Monitor size={20} strokeWidth={3} />}>Desk</Title>
      </TitleBar>

      {!session && (
        <button className="card-panel row row--between" style={{ width: '100%', marginBottom: 20, textAlign: 'left' }} onClick={() => nav('/settings')}>
          <span><b>Sign in on both devices</b><div className="setting__sub">to link phone and desk</div></span>
          <ExternalLink size={18} />
        </button>
      )}

      <AnimatePresence>
        {blocked && (
          <motion.div initial={{ y: -10, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ opacity: 0 }} className="card-panel row row--between" style={{ marginBottom: 20, borderColor: 'var(--value)' }}>
            <span><b>Pop-up blocked</b><div className="setting__sub">Allow pop-ups for this app once</div></span>
            <a className="btn btn--sm btn--accent" href={blocked} target="_blank" rel="noreferrer" onClick={() => setBlocked(null)}>Open</a>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="companion">
        <div className="companion__hero">
          <AnimatePresence mode="wait">
            {heroEv ? (
              <motion.div key={heroEv.at} className="companion__hero" initial={{ scale: 0.8, opacity: 0, rotate: -4 }} animate={{ scale: 1, opacity: 1, rotate: 0 }} exit={{ scale: 0.95, opacity: 0 }} transition={{ type: 'spring', stiffness: 320, damping: 26 }} style={{ width: '100%' }}>
                <CardImage src={heroEv.image} alt={heroEv.cardName} quality="high" />
                <span className={`title ${heroEv.action === 'remove' ? 'title--danger' : heroEv.highValue ? 'title--value' : heroEv.artistStatus === 'unknown' ? 'title--new' : heroEv.artistStatus === 'not-collecting' ? 'title--grey' : ''}`}>
                  {heroEv.action === 'remove' ? 'Removed' : heroEv.highValue ? 'High value' : STATUS_WORD[heroEv.artistStatus]}
                </span>
                <div>
                  <div className="big">{heroEv.cardName}</div>
                  <div className="muted" style={{ fontWeight: 700 }}>{heroEv.artist ?? 'Unknown artist'}</div>
                </div>
                <div className={`scan__value ${heroEv.highValue ? 'scan__value--hot' : ''}`}>{fmtAud(heroEv.valueAud)}</div>
                <div className="row" style={{ flexWrap: 'wrap', justifyContent: 'center' }}>
                  {heroEv.artist && <a className="btn btn--sm" href={artofpkmUrl(heroEv.artist)} target="_blank" rel="noreferrer"><Palette size={14} /> Art of PKM</a>}
                  {heroEv.tcgplayerId && <a className="btn btn--sm" href={`https://www.tcgplayer.com/product/${heroEv.tcgplayerId}`} target="_blank" rel="noreferrer"><ExternalLink size={14} /> TCGplayer</a>}
                  {heroEv.artistKey && <button className="btn btn--sm btn--ghost" onClick={() => nav(`/artist/${encodeURIComponent(heroEv.artistKey!)}`)}>Artist</button>}
                </div>
              </motion.div>
            ) : (
              <div className="empty" style={{ width: '100%' }}>
                <Monitor size={44} />
                <div className="big" style={{ color: 'var(--text-2)' }}>Waiting for scans</div>
              </div>
            )}
          </AnimatePresence>
        </div>

        <div className="feed">
          <AnimatePresence initial={false}>
            {items.map((ev) => (
              <motion.button
                key={ev.id ?? ev.at}
                layout
                className="feed__item"
                style={{ textAlign: 'left', width: '100%' }}
                initial={{ x: 40, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                onClick={() => setHero({ ev, card: null })}
              >
                <CardImage src={ev.image} alt={ev.cardName} />
                <div className="list__grow">
                  <div className="list__title">{ev.cardName}</div>
                  <div className="list__sub">{ev.artist ?? '—'}</div>
                </div>
                {ev.action === 'remove' ? <span className="chip" style={{ background: 'var(--danger)', color: 'var(--danger-ink)' }}><Minus size={12} /></span>
                  : ev.highValue ? <span className="chip chip--value">{fmtAud(ev.valueAud)}</span>
                  : ev.artistStatus === 'unknown' ? <span className="chip chip--unknown"><Sparkles size={12} /> New</span>
                  : <StatusChip status={ev.artistStatus} />}
                <span className="feed__time">{new Date(ev.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              </motion.button>
            ))}
          </AnimatePresence>
          {items.length === 0 && <div className="empty muted">—</div>}
        </div>
      </div>
    </div>
  )
}
