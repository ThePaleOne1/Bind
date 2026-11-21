import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Zap, ZapOff, Search, Plus, Minus, X, ChevronLeft, Sun } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../data/db'
import type { CardRecord, IndexEntry, ScanEvent } from '../data/types'
import { startCamera, type CameraHandle } from '../recognition/camera'
import { FrameAnalyzer, type Phase, type Roi } from '../recognition/frameAnalyzer'
import { captureRoi, recognize, betterOf, setNameOf, type Recognition } from '../recognition/recognizer'
import { warmOcr } from '../recognition/ocr'
import { loadIndex, getCard } from '../api/tcgdex'
import { searchIndex } from '../recognition/matcher'
import { applyScan } from '../store/collection'
import { useSettings } from '../store/settings'
import { sendCompanion } from '../sync/companion'
import { buzz, chime } from '../utils/haptics'
import { fmtAud } from '../utils/price'
import { Particles, PALETTES } from '../components/Particles'
import { CardImage, Sheet, STATUS_WORD, toast } from '../components/ui'

type Result = { ev: ScanEvent; card: CardRecord; rec: Recognition }

export default function Scan() {
  const nav = useNavigate()
  const videoRef = useRef<HTMLVideoElement>(null)
  const fxRef = useRef<HTMLCanvasElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const cam = useRef<CameraHandle | null>(null)
  const analyzer = useRef(new FrameAnalyzer())
  const particles = useRef<Particles | null>(null)
  const busy = useRef(false)
  const [phase, setPhase] = useState<Phase>('empty')
  const [camError, setCamError] = useState<string | null>(null)
  const [torch, setTorch] = useState(false)
  const [exposure, setExposure] = useState(0)          // EV steps: 0, -1, -2 (glare)
  const [hasExposure, setHasExposure] = useState(false)
  const [result, setResult] = useState<Result | null>(null)
  const [miss, setMiss] = useState<Recognition | null>(null)
  const [search, setSearch] = useState(false)
  const [flash, setFlash] = useState<string | null>(null)
  const [debug, setDebug] = useState(false)
  const [indexReady, setIndexReady] = useState<boolean | null>(null)
  const mode = useSettings((s) => s.scanMode)
  const setSettings = useSettings((s) => s.set)
  const { sound, haptics, highValueAud } = useSettings()
  const todayCount = useLiveQuery(async () => {
    const start = new Date(); start.setHours(0, 0, 0, 0)
    return db.scans.where('at').above(start.getTime()).count()
  }, [], 0)

  // Guide region: card aspect 63:88 centred, 72% of the shorter side wide
  const roi = useMemo<() => Roi>(() => () => {
    const v = videoRef.current
    if (!v || !v.videoWidth) return { x: 0.2, y: 0.2, w: 0.6, h: 0.6 }
    const vw = v.videoWidth, vh = v.videoHeight
    const el = v.getBoundingClientRect()
    // object-fit: cover → compute visible region of the video in video pixels
    const scale = Math.max(el.width / vw, el.height / vh)
    const visW = el.width / scale, visH = el.height / scale
    const portrait = el.height > el.width
    const cardW = portrait ? visW * 0.74 : visH * 0.62 * (63 / 88)
    const cardH = cardW * (88 / 63)
    return { x: (vw - cardW) / 2 / vw, y: (vh - cardH) / 2 / vh - (portrait ? 0.03 : 0), w: cardW / vw, h: cardH / vh }
  }, [])

  // Place the on-screen frame where the ROI is
  const [frameBox, setFrameBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null)
  const layoutFrame = useCallback(() => {
    const v = videoRef.current
    if (!v || !v.videoWidth) return
    const r = roi()
    const el = v.getBoundingClientRect()
    const vw = v.videoWidth, vh = v.videoHeight
    const scale = Math.max(el.width / vw, el.height / vh)
    const offX = (el.width - vw * scale) / 2, offY = (el.height - vh * scale) / 2
    setFrameBox({ left: offX + r.x * vw * scale, top: offY + r.y * vh * scale, width: r.w * vw * scale, height: r.h * vh * scale })
    particles.current?.resize()
  }, [roi])

  // Camera lifecycle
  useEffect(() => {
    let alive = true
    const v = videoRef.current!
    warmOcr()
    loadIndex().then(() => alive && setIndexReady(true)).catch(() => alive && setIndexReady(false))
    startCamera(v).then((h) => {
      if (!alive) { h.stop(); return }
      cam.current = h
      setHasExposure(!!h.exposureRange)
      layoutFrame()
    }).catch((e) => setCamError(e?.message ?? 'Camera unavailable'))
    v.addEventListener('loadedmetadata', layoutFrame)
    window.addEventListener('resize', layoutFrame)
    if (fxRef.current) particles.current = new Particles(fxRef.current)
    return () => {
      alive = false
      cam.current?.stop()
      v.removeEventListener('loadedmetadata', layoutFrame)
      window.removeEventListener('resize', layoutFrame)
      particles.current?.destroy()
    }
  }, [layoutFrame])

  // Hands-free analysis loop (~12 fps)
  useEffect(() => {
    let raf = 0
    let last = 0
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick)
      if (t - last < 80) return
      last = t
      const v = videoRef.current
      if (!v || !cam.current || busy.current || result) return
      const fire = analyzer.current.step(v, roi(), t)
      setPhase(analyzer.current.phase)
      if (fire) void capture()
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [roi, result])

  const feedback = (kind: 'ok' | 'alert' | 'remove' | 'fail', pattern: number | number[]) => {
    if (sound) chime(kind)
    if (haptics) buzz(pattern)
  }

  const burstAt = (palette: string[], power = 1) => {
    const p = particles.current, f = frameBox
    if (!p || !f) return
    p.burst(f.left + f.width / 2, f.top + f.height / 2, palette, 110, power)
    p.ring(f.left + f.width / 2, f.top + f.height / 2, Math.min(f.width, f.height) * 0.45, palette)
  }

  const commit = useCallback(async (card: CardRecord, rec: Recognition) => {
    const ev = await applyScan(card, mode)
    const palette = mode === 'remove' ? PALETTES.remove : ev.highValue ? PALETTES.value : PALETTES[ev.artistStatus]
    burstAt(palette, ev.highValue ? 1.5 : 1)
    setFlash(mode === 'remove' ? 'var(--danger)' : ev.highValue ? 'var(--value)' : ev.artistStatus === 'collecting' ? 'var(--accent)' : ev.artistStatus === 'unknown' ? 'var(--new)' : 'transparent')
    setTimeout(() => setFlash(null), 350)
    if (mode === 'remove') feedback('remove', [30, 40, 30])
    else if (ev.highValue) feedback('alert', [40, 60, 40, 60, 120])
    else feedback('ok', ev.artistStatus === 'collecting' ? [25, 40, 25] : 25)
    sendCompanion({ type: 'scan', scan: ev })
    setResult({ ev, card, rec })
    // Result stays visible until the card leaves the frame (or 2.5s on desktop with no movement)
    setTimeout(() => { setResult(null); analyzer.current.release() }, 1800)
  }, [mode, frameBox, sound, haptics])

  const capture = useCallback(async () => {
    const v = videoRef.current
    if (!v || busy.current) return
    busy.current = true
    try {
      let rec = await recognize(captureRoi(v, roi()), { debug })
      if (!rec.card) {
        // Glare and holo noise vary frame to frame: one quick second attempt.
        await new Promise((r) => setTimeout(r, 180))
        rec = betterOf(rec, await recognize(captureRoi(v, roi()), { debug }))
      }
      if (rec.card) {
        await commit(rec.card, rec)
      } else {
        feedback('fail', 60)
        setMiss(rec)
        analyzer.current.release()
      }
    } catch (e: any) {
      toast(e?.message ?? 'Scan failed')
      analyzer.current.release()
    } finally {
      busy.current = false
    }
  }, [roi, commit, debug])

  const cycleExposure = async () => {
    if (!cam.current?.exposureRange) return
    const next = exposure <= -2 ? 0 : exposure - 1
    const { min, step } = cam.current.exposureRange
    // -1 "step" = one third of the range below zero, so it works on any device scale
    const ev = next === 0 ? 0 : Math.max(min, Math.round((next * Math.abs(min) / 3) / step) * step)
    if (await cam.current.setExposure(ev)) setExposure(next)
  }

  const pickAlternative = async (id: string) => {
    const rec = miss
    setMiss(null)
    const card = await getCard(id)
    busy.current = true
    try { await commit(card, rec ?? ({} as Recognition)) } finally { busy.current = false }
  }

  const toggleTorch = async () => {
    if (!cam.current) return
    const on = await cam.current.torch(!torch)
    setTorch(on)
  }

  const lastRec = result?.rec ?? miss
  const statusWord = result ? 'Scanned' : phase === 'settling' ? 'Hold' : phase === 'capture' || busy.current ? 'Reading' : phase === 'busy' ? 'Next card' : 'Ready'
  const dotClass = phase === 'settling' ? 'scan__dot--hold' : phase === 'capture' || busy.current ? 'scan__dot--busy' : phase === 'empty' ? 'scan__dot--on' : ''

  return (
    <div className="scan" onDoubleClick={() => setDebug((d) => !d)}>
      <video ref={videoRef} playsInline muted autoPlay />
      <AnimatePresence>
        {flash && <motion.div className="scan__flash" style={{ background: flash }} initial={{ opacity: 0.55 }} animate={{ opacity: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.4 }} />}
      </AnimatePresence>

      {frameBox && (
        <div
          ref={frameRef}
          className={`scan__frame ${phase === 'settling' ? 'scan__frame--hold' : ''} ${phase === 'capture' || busy.current ? 'scan__frame--busy' : ''} ${mode === 'remove' ? 'scan__frame--remove' : ''}`}
          style={frameBox}
        >
          <i className="scan__corner tl" /><i className="scan__corner tr" /><i className="scan__corner bl" /><i className="scan__corner br" />
        </div>
      )}
      {frameBox && !result && phase === 'empty' && (
        <div className="scan__hint" style={{ top: frameBox.top + frameBox.height + 14 }}>Place card</div>
      )}
      {frameBox && !result && phase === 'busy' && !busy.current && (
        <div className="scan__hint" style={{ top: frameBox.top + frameBox.height + 14 }}>Lift card</div>
      )}

      <canvas ref={fxRef} className="fx" />

      <div className="scan__top">
        <button className="iconbtn iconbtn--ghost" style={{ background: 'rgba(7,20,17,.6)' }} onClick={() => nav(-1)} aria-label="Back"><ChevronLeft /></button>
        <div className="scan__status">
          <span className={`scan__dot ${dotClass}`} />
          {camError ? 'No camera' : indexReady === false ? 'Offline' : statusWord}
        </div>
        <div className="row" style={{ gap: 8 }}>
          {hasExposure && (
            <button className="iconbtn iconbtn--ghost" style={{ background: 'rgba(7,20,17,.6)', color: exposure ? 'var(--accent)' : undefined, width: 'auto', padding: '0 12px', borderRadius: 22, gap: 4 }} onClick={cycleExposure} aria-label="Glare">
              <Sun size={20} />{exposure ? <b style={{ fontSize: 'var(--fs-sm)' }}>{exposure}</b> : null}
            </button>
          )}
          <button className="iconbtn iconbtn--ghost" style={{ background: 'rgba(7,20,17,.6)', color: torch ? 'var(--accent)' : undefined }} onClick={toggleTorch} aria-label="Torch" disabled={!cam.current?.hasTorch}>
            {torch ? <Zap /> : <ZapOff />}
          </button>
        </div>
      </div>

      <AnimatePresence>
        {result && (
          <motion.div className="scan__result" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.25 } }}>
            <motion.div
              className="scan__resultcard"
              initial={{ scale: 0.4, rotate: -8, y: 60 }}
              animate={{ scale: 1, rotate: 0, y: 0 }}
              exit={{ scale: 0.85, y: -30, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 380, damping: 26 }}
            >
              <CardImage src={result.card.image} alt={result.card.name} quality="high" />
            </motion.div>
            <motion.div className="scan__word" initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 400, damping: 22, delay: 0.08 }}>
              <span className={`title ${result.ev.action === 'remove' ? 'title--danger' : result.ev.highValue ? 'title--value' : result.ev.artistStatus === 'unknown' ? 'title--new' : result.ev.artistStatus === 'not-collecting' ? 'title--grey' : ''}`} style={{ fontSize: 'clamp(22px, 6vw, 34px)' }}>
                {result.ev.action === 'remove' ? 'Removed' : result.ev.highValue ? 'High value' : STATUS_WORD[result.ev.artistStatus]}
              </span>
            </motion.div>
            <motion.div initial={{ y: 12, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ delay: 0.15 }} className="stack" style={{ alignItems: 'center', gap: 6 }}>
              <div className="scan__name">{result.card.name}</div>
              <div className="scan__sub">{result.card.illustrator ?? 'Unknown artist'} · {result.card.localId}/{result.card.setTotal || '?'}</div>
              <div className={`scan__value ${result.ev.highValue ? 'scan__value--hot' : ''}`}>{fmtAud(result.ev.valueAud)}</div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {debug && (
        <div className="scan__ocr" style={{ bottom: 110 }}>
          {`phase=${phase} presence=${analyzer.current.presence.toFixed(3)} motion=${analyzer.current.motion.toFixed(3)} sharp=${analyzer.current.sharpness.toFixed(4)}\n`}
          {lastRec ? `top="${lastRec.ocr?.top}"\nbottom="${lastRec.ocr?.bottom}"\n${lastRec.ms?.toFixed(0)}ms conf=${lastRec.confidence?.toFixed(2)} num=${lastRec.parsed?.number ?? '-'}/${lastRec.parsed?.total ?? '-'} name=${lastRec.parsed?.nameGuess ?? ''} illus=${lastRec.parsed?.illustratorGuess ?? '-'}` : ''}
          {lastRec?.bands && (
            <div style={{ marginTop: 6, display: 'grid', gap: 4 }}>
              <img src={lastRec.bands.top} style={{ width: '100%', border: '1px solid var(--line-strong)' }} alt="" />
              <img src={lastRec.bands.bottom} style={{ width: '100%', border: '1px solid var(--line-strong)' }} alt="" />
            </div>
          )}
        </div>
      )}

      <div className="scan__bottom">
        <div className="scan__mode">
          <button className={mode === 'add' ? 'on' : ''} onClick={() => setSettings({ scanMode: 'add' })}><Plus size={16} strokeWidth={3} /> Add</button>
          <button className={`${mode === 'remove' ? 'on remove' : ''}`} onClick={() => setSettings({ scanMode: 'remove' })}><Minus size={16} strokeWidth={3} /> Remove</button>
        </div>
        <div className="scan__count" title="Scanned today">{todayCount}</div>
        <button className="iconbtn" style={{ background: 'rgba(7,20,17,.72)' }} onClick={() => setSearch(true)} aria-label="Search"><Search /></button>
      </div>

      {/* Not recognised → pick from candidates or search */}
      <Sheet open={!!miss} onClose={() => setMiss(null)}>
        {miss && (
          <div className="stack">
            <div className="row row--between">
              <span className="title title--grey title--sm">Not sure</span>
              <button className="iconbtn iconbtn--ghost" onClick={() => setMiss(null)}><X /></button>
            </div>
            <div className="muted">
              Read{' '}
              <b className="mono" style={{ color: 'var(--text)' }}>{miss.parsed.number ? `${miss.parsed.number}${miss.parsed.total ? `/${miss.parsed.total}` : ''}` : 'no number'}</b>
              {miss.parsed.nameGuess ? <> · <b style={{ color: 'var(--text)' }}>{miss.parsed.nameGuess}</b></> : null}
              {miss.parsed.illustratorGuess ? <> · <b style={{ color: 'var(--text)' }}>{miss.parsed.illustratorGuess}</b></> : null}
            </div>
            {miss.alternatives.length > 0 ? (
              <div className="grid">
                {miss.alternatives.slice(0, 8).map((a) => <AltTile key={a.entry.id} entry={a.entry} onPick={() => pickAlternative(a.entry.id)} />)}
              </div>
            ) : (
              <div className="empty">No match</div>
            )}
            <button className="btn btn--accent btn--block" onClick={() => { setMiss(null); setSearch(true) }}><Search size={18} /> Search</button>
          </div>
        )}
      </Sheet>

      <SearchSheet open={search} onClose={() => setSearch(false)} onPick={async (id) => { setSearch(false); await pickAlternative(id) }} />
    </div>
  )
}

/** Candidate tile: shows set name and illustrator so look-alike cards can be told apart. */
function AltTile({ entry, onPick }: { entry: IndexEntry; onPick: () => void }) {
  const [sub, setSub] = useState<string>(`${entry.n}/${entry.total}`)
  useEffect(() => {
    let alive = true
    Promise.all([setNameOf(entry.set), getCard(entry.id).catch(() => null)]).then(([set, card]) => {
      if (alive) setSub(`${set} · ${entry.n}/${entry.total}${card?.illustrator ? ` · ${card.illustrator}` : ''}`)
    })
    return () => { alive = false }
  }, [entry.id])
  return (
    <button className="tile" onClick={onPick}>
      <CardImage src={entry.img} alt={entry.name} />
      <div className="list__title" style={{ fontSize: 'var(--fs-sm)', marginTop: 6 }}>{entry.name}</div>
      <div className="list__sub" style={{ whiteSpace: 'normal', lineHeight: 1.25 }}>{sub}</div>
    </button>
  )
}

export function SearchSheet({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (id: string) => void }) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<IndexEntry[]>([])
  useEffect(() => {
    if (!open) { setQ(''); setResults([]); return }
  }, [open])
  useEffect(() => {
    let alive = true
    const t = setTimeout(async () => {
      if (q.trim().length < 2) { setResults([]); return }
      const idx = await loadIndex()
      const r = searchIndex(q, idx, 30).map((c) => c.entry)
      if (alive) setResults(r)
    }, 220)
    return () => { alive = false; clearTimeout(t) }
  }, [q])
  return (
    <Sheet open={open} onClose={onClose}>
      <div className="stack">
        <div className="search">
          <Search className="search__icon" size={18} />
          <input className="input" autoFocus placeholder="Name or 025/198" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="grid">
          {results.map((e) => (
            <button key={e.id} className="tile" onClick={() => onPick(e.id)}>
              <CardImage src={e.img} alt={e.name} />
              <div className="list__title" style={{ fontSize: 'var(--fs-sm)', marginTop: 6 }}>{e.name}</div>
              <div className="list__sub">{e.set.toUpperCase()} · {e.n}/{e.total}</div>
            </button>
          ))}
        </div>
      </div>
    </Sheet>
  )
}
