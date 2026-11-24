import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Play, Send, Share2, Camera, Check, X, Zap, ZapOff, ListChecks, Plus, Trash2 } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { startCamera, type CameraHandle } from '../recognition/camera'
import type { Roi } from '../recognition/frameAnalyzer'
import { recognize, type Recognition } from '../recognition/recognizer'
import { guideRoi, widen, roiToScreen, grabWide, locateCard, thumb } from '../recognition/pipeline'
import { warmOcr } from '../recognition/ocr'
import { loadIndex, getCard, printedCode } from '../api/tcgdex'
import { BENCH_CARDS, BENCH_ATTEMPTS, type BenchCard } from '../data/bench'
import { finishesOf, FINISH_LABEL } from '../data/finish'
import type { Finish } from '../data/types'
import { useSettings } from '../store/settings'
import { sendCompanion, companionConnected } from '../sync/companion'
import { baseReport, logEvent } from '../utils/perfLog'
import { BUILD } from '../pwa'
import { Segmented, Sheet, toast } from '../components/ui'
import { SearchSheet } from './Scan'

/** One read of one card on the bench: everything the recogniser produced, nothing committed. */
interface Attempt {
  i: number
  ms: number
  still: boolean
  found: boolean
  cardPct: number            // detected card width as % of the guide
  ocr: Recognition['ocr']
  number: string | null
  total: number | null
  nameGuess: string
  setCodes: string[]
  best: { id: string; name: string; conf: number } | null
  hit: boolean
  alternatives: string[]
  foil: Recognition['foil']
  sharp: number
  cropIndex: number          // index into the crops list
}
interface CardRun { index: number; card: BenchCard; attempts: Attempt[]; startedAt: number }

/**
 * Scanner test bench. Walks the test deck one card at a time: put the card in, press
 * Scan, and it reads the card BENCH_ATTEMPTS times, recording every read and crop,
 * then moves to the next card. Nothing is added to the collection. One Send at the
 * end delivers the whole session to the Desk as a report with every crop.
 */
export default function Bench() {
  const nav = useNavigate()
  const videoRef = useRef<HTMLVideoElement>(null)
  const cam = useRef<CameraHandle | null>(null)
  const track = useRef<Roi | null>(null)
  const [frameBox, setFrameBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null)
  const [camError, setCamError] = useState<string | null>(null)
  const [camLabel, setCamLabel] = useState('')
  const [ready, setReady] = useState<boolean | null>(null)   // catalogue loaded (false: could not)
  const [focused, setFocused] = useState(false)      // Start pressed (focus calibrated)
  const [starting, setStarting] = useState(false)
  const [torch, setTorch] = useState(false)
  const [idx, setIdx] = useState(0)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [runs, setRuns] = useState<CardRun[]>([])
  const crops = useRef<{ card: number; i: number; jpeg: string }[]>([])
  const [sending, setSending] = useState(false)
  const [sentNote, setSentNote] = useState<string | null>(null)
  const sessionId = useRef(Math.random().toString(36).slice(2, 8))
  // Session conditions, so reads from different rooms and setups can be told apart
  const [lighting, setLighting] = useState<'overhead' | 'daylight' | 'lamp' | 'dim'>('overhead')
  const [rig, setRig] = useState<'jig' | 'handheld'>('jig')
  const [note, setNote] = useState('')
  const [endNote, setEndNote] = useState('')   // anything noticed while scanning, written before sending
  const { preview4k, cameraId, benchCards, set: setSettings } = useSettings()
  const deck: BenchCard[] = benchCards ?? BENCH_CARDS
  // Deck editor
  const [editing, setEditing] = useState(false)
  const [adding, setAdding] = useState(false)
  const [pending, setPending] = useState<{ id: string; name: string; number: string; options: Finish[]; finish: Finish; lang?: 'ja' } | null>(null)
  // A card the catalogue lacks: the bench still records what the scanner makes of it.
  const [unlisted, setUnlisted] = useState<{ name: string; number: string; finish: Finish; ja: boolean } | null>(null)

  const layout = () => {
    const v = videoRef.current
    if (!v || !v.videoWidth) return
    setFrameBox(roiToScreen(v, track.current ?? guideRoi(v)))
  }

  useEffect(() => {
    let alive = true
    const v = videoRef.current!
    warmOcr()
    loadIndex().then(() => alive && setReady(true)).catch(() => alive && setReady(false))
    startCamera(v, { deviceId: cameraId || null, hiRes: preview4k }).then((h) => {
      if (!alive) { h.stop(); return }
      cam.current = h
      setCamLabel(`${v.videoWidth}x${v.videoHeight} ${h.devices.find((d) => d.id === h.deviceId)?.label ?? ''} still=${h.canStill() ? 'yes' : 'no'}`)
      layout()
    }).catch((e) => { if (alive) setCamError(e?.message ?? 'Camera unavailable') })
    v.addEventListener('loadedmetadata', layout)
    window.addEventListener('resize', layout)
    return () => { alive = false; cam.current?.stop(); v.removeEventListener('loadedmetadata', layout); window.removeEventListener('resize', layout) }
  }, [])

  const start = async () => {
    const v = videoRef.current
    if (!cam.current || !v) return
    setStarting(true)
    if (!ready) {
      // the catalogue failed to load when the screen opened (offline, API hiccup): try again now
      try { await loadIndex(); setReady(true) } catch { toast('Card catalogue unavailable: check the connection'); setReady(false); setStarting(false); return }
    }
    try {
      const { sharpnessOfVideo, BLUR_THRESHOLD } = await import('../recognition/focus')
      await cam.current.refocus({ measure: () => sharpnessOfVideo(v, track.current ?? guideRoi(v)), good: BLUR_THRESHOLD, full: true })
    } catch { /* ignore */ }
    setStarting(false); setFocused(true)
  }

  const card = deck[Math.min(idx, deck.length - 1)]
  const current = runs.find((r) => r.index === idx)

  /** Read the card in the jig BENCH_ATTEMPTS times and record everything, then move on. */
  const scan = async () => {
    const v = videoRef.current
    if (!v || !v.videoWidth || busy || !card) return
    setBusy(true); setProgress(0)
    const attempts: Attempt[] = []
    const run: CardRun = { index: idx, card, attempts, startedAt: Date.now() }
    setRuns((l) => [...l.filter((r) => r.index !== idx), run])
    const ja = card.lang === 'ja' || card.expected.some((id) => id.startsWith('ja:'))
    try {
      for (let i = 0; i < BENCH_ATTEMPTS; i++) {
        const t0 = performance.now()
        const guide = guideRoi(v)
        const wide = widen(guide)
        const grab = await grabWide(v, cam.current, wide)
        const loc = locateCard(grab.canvas, wide, guide, track.current, v)
        if (loc.moved) { track.current = loc.roi; layout() }
        const rec = await recognize(loc.canvas, { ja })
        const cropIndex = crops.current.length
        crops.current.push({ card: idx, i, jpeg: thumb(loc.canvas, 480, 0.5) })
        const best = rec.alternatives[0] ?? null
        const a: Attempt = {
          i, ms: performance.now() - t0, still: grab.still, found: loc.found,
          cardPct: Math.round(loc.roi.w / guide.w * 100),
          ocr: rec.ocr,
          number: rec.parsed.number, total: rec.parsed.total, nameGuess: rec.parsed.nameGuess, setCodes: rec.parsed.setCodes,
          best: rec.card ? { id: rec.card.id, name: rec.card.name, conf: rec.confidence } : best ? { id: best.entry.id, name: best.entry.name, conf: rec.confidence } : null,
          // An unlisted card (nothing expected) is handled right when the scanner commits to nothing.
          hit: card.expected.length ? !!rec.card && card.expected.includes(rec.card.id) : !rec.card,
          alternatives: rec.alternatives.slice(0, 5).map((c) => `${c.entry.id} ${c.score.toFixed(2)}`),
          foil: rec.foil, sharp: rec.sharpness, cropIndex,
        }
        attempts.push(a)
        setProgress(i + 1)
        setRuns((l) => l.map((r) => (r.index === idx ? { ...r, attempts: [...attempts] } : r)))
        logEvent('bench', `${card.name} #${i + 1} ${a.hit ? 'hit' : a.best ? 'miss ' + a.best.id : 'nothing'} ${Math.round(a.ms)}ms`)
        await new Promise((r) => setTimeout(r, 350))
      }
      // On to the next card: all that is left to do is swap the card and press Scan again
      if (idx < deck.length - 1) setIdx(idx + 1)
    } catch (e: any) {
      toast(e?.message ?? 'Bench read failed')
    } finally {
      setBusy(false)
    }
  }

  const report = () => ({
    ...baseReport(BUILD), id: sessionId.current, source: 'bench',
    camera: camLabel, settings: { preview4k },
    conditions: { lighting, rig, note, endNote },
    attemptsPerCard: BENCH_ATTEMPTS,
    deck: deck.map((c) => ({ name: c.name, number: c.number, expected: c.expected, finish: c.finish })),
    cards: [...runs].sort((a, b) => a.index - b.index).map((r) => ({
      index: r.index, name: r.card.name, number: r.card.number, expected: r.card.expected, finish: r.card.finish, note: r.card.note,
      attempts: r.attempts,
    })),
    cropCount: crops.current.length,
  })

  const send = async () => {
    if (sending) return
    setSending(true)
    try {
      const text = report()
      const images = crops.current
      if (!companionConnected()) {
        const file = new File([JSON.stringify({ ...text, cropImages: images })], `bind-bench-${sessionId.current}.json`, { type: 'application/json' })
        const n = navigator as any
        if (n.share && (!n.canShare || n.canShare({ files: [file] }))) { try { await n.share({ files: [file], title: 'Bind bench' }) } catch { /* cancelled */ } }
        else { const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; a.click() }
        toast('Desk not linked: shared the file instead')
        return
      }
      const ok = await sendCompanion({ type: 'report', report: text })
      let sent = 0
      // The live link drops bursts: one crop every 200 ms, with progress on screen
      for (let k = 0; k < images.length; k++) {
        const c = images[k]
        if (await sendCompanion({ type: 'report-crop', report: { id: sessionId.current, i: k, card: c.card, attempt: c.i, jpeg: c.jpeg } })) sent++
        setSentNote(`Sending crops ${k + 1}/${images.length}`)
        await new Promise((r) => setTimeout(r, 200))
      }
      setSentNote(null)
      toast(ok ? `Sent to Desk: ${runs.length} cards, ${sent}/${images.length} crops` : 'Could not reach the Desk')
    } finally { setSending(false) }
  }

  // ---- deck editing ----
  const removeCard = (i: number) => {
    const next = deck.filter((_, k) => k !== i)
    setSettings({ benchCards: next })
    setRuns((l) => l.filter((r) => r.index !== i).map((r) => (r.index > i ? { ...r, index: r.index - 1 } : r)))
    if (idx >= next.length) setIdx(Math.max(0, next.length - 1))
  }
  const pickCard = async (id: string) => {
    setAdding(false)
    try {
      const c = await getCard(id, { quick: true })
      const options = finishesOf(c)
      setPending({ id, name: `${c.name}${c.lang === 'ja' ? ' (JP)' : ''}`, number: `${c.localId}/${c.setTotal || '?'} · ${printedCode(c.setId).toUpperCase()}`, options, finish: options[0], ...(c.lang === 'ja' ? { lang: 'ja' as const } : {}) })
    } catch { toast('Could not load that card') }
  }
  const addPending = () => {
    if (!pending) return
    setSettings({ benchCards: [...deck, { name: pending.name, number: pending.number, expected: [pending.id], finish: pending.finish, ...(pending.lang ? { lang: pending.lang } : {}) }] })
    setPending(null)
  }
  const addUnlisted = () => {
    if (!unlisted || !unlisted.name.trim()) return
    setSettings({ benchCards: [...deck, { name: `${unlisted.name.trim()}${unlisted.ja ? ' (JP)' : ''}`, number: unlisted.number.trim() || '—', expected: [], finish: unlisted.finish, note: 'not in the catalogue', ...(unlisted.ja ? { lang: 'ja' as const } : {}) }] })
    setUnlisted(null)
  }
  const resetDeck = () => { setSettings({ benchCards: null }); setRuns([]); setIdx(0) }

  const toggleTorch = async () => { if (cam.current) setTorch(await cam.current.torch(!torch)) }
  const hits = current ? current.attempts.filter((a) => a.hit).length : 0
  const done = runs.filter((r) => r.attempts.length > 0).length

  return (
    <div className="scan">
      <video ref={videoRef} playsInline muted autoPlay />
      {frameBox && (
        <>
          <div className="scan__dim" style={{ left: 0, top: 0, right: 0, height: frameBox.top }} />
          <div className="scan__dim" style={{ left: 0, top: frameBox.top + frameBox.height, right: 0, bottom: 0 }} />
          <div className="scan__dim" style={{ left: 0, top: frameBox.top, width: frameBox.left, height: frameBox.height }} />
          <div className="scan__dim" style={{ left: frameBox.left + frameBox.width, top: frameBox.top, right: 0, height: frameBox.height }} />
          <div className={`scan__frame ${busy ? 'scan__frame--busy' : ''}`} style={{ ...frameBox, transition: 'left 0.25s, top 0.25s, width 0.25s, height 0.25s' }}>
            <i className="scan__corner tl" /><i className="scan__corner tr" /><i className="scan__corner bl" /><i className="scan__corner br" />
          </div>
        </>
      )}

      <div className="scan__top">
        <button className="iconbtn iconbtn--ghost" style={{ background: 'rgba(7,20,17,.6)' }} onClick={() => nav(-1)} aria-label="Back"><ChevronLeft /></button>
        <div className="scan__status">{camError ? 'No camera' : ready === null ? 'Loading' : ready === false ? 'Offline' : `Bench ${done}/${deck.length}`}</div>
        <div className="row" style={{ gap: 8 }}>
          <button className="iconbtn iconbtn--ghost" style={{ background: 'rgba(7,20,17,.6)' }} onClick={() => setEditing(true)} aria-label="Edit the test deck"><ListChecks /></button>
          <button className="iconbtn iconbtn--ghost" style={{ background: 'rgba(7,20,17,.6)', color: torch ? 'var(--accent)' : undefined }} onClick={toggleTorch} aria-label="Torch" disabled={!cam.current?.hasTorch}>{torch ? <Zap /> : <ZapOff />}</button>
        </div>
      </div>

      {/* Which card to put in, and how the last reads went */}
      <div className="bench__card">
        {card ? (
          <div className="row row--between">
            <button className="iconbtn iconbtn--ghost" onClick={() => setIdx((i) => Math.max(0, i - 1))} disabled={busy || idx === 0} aria-label="Previous card"><ChevronLeft /></button>
            <div style={{ textAlign: 'center', minWidth: 0 }}>
              <div className="muted" style={{ fontSize: 'var(--fs-xs)', fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Card {idx + 1} of {deck.length} · {card.finish === 'normal' ? 'standard' : card.finish === 'reverse' ? 'reverse holo' : card.finish}</div>
              <div className="scan__tagname" style={{ fontSize: 'var(--fs-xl)' }}>{card.name}</div>
              <div className="scan__tagsub">{card.number}{card.note ? ` · ${card.note}` : ''}</div>
            </div>
            <button className="iconbtn iconbtn--ghost" onClick={() => setIdx((i) => Math.min(deck.length - 1, i + 1))} disabled={busy || idx === deck.length - 1} aria-label="Next card"><ChevronRight /></button>
          </div>
        ) : <div className="empty">The deck is empty</div>}
        {!focused && (
          <div className="stack" style={{ gap: 8 }}>
            <Segmented id="lighting" value={lighting} onChange={setLighting} options={[{ value: 'overhead', label: 'Overhead' }, { value: 'daylight', label: 'Daylight' }, { value: 'lamp', label: 'Lamp' }, { value: 'dim', label: 'Dim' }]} />
            <Segmented id="rig" value={rig} onChange={setRig} options={[{ value: 'jig', label: 'In the jig' }, { value: 'handheld', label: 'Handheld' }]} />
            <input className="input" placeholder="Anything else about this session (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        )}
        {current && current.attempts.length > 0 && (
          <div className="bench__reads">
            {current.attempts.map((a) => (
              <span key={a.i} className={`chip ${a.hit ? 'chip--collecting' : a.best ? 'chip--not-collecting' : 'chip--outline'}`} style={{ height: 26, fontSize: 'var(--fs-xs)' }}>
                {a.hit ? <Check size={12} strokeWidth={3} /> : <X size={12} strokeWidth={3} />} {a.best ? a.best.name.slice(0, 12) : 'nothing'} · {(a.ms / 1000).toFixed(1)}s{a.foil ? ` · ${a.foil.ratio.toFixed(2)}` : ''}
              </span>
            ))}
            {!busy && <span className="muted" style={{ fontSize: 'var(--fs-xs)', fontWeight: 700 }}>{hits}/{current.attempts.length} right</span>}
          </div>
        )}
        {focused && done > 0 && !busy && (
          <input className="input" placeholder="Anything you noticed while scanning (sent with the report)" value={endNote} onChange={(e) => setEndNote(e.target.value)} />
        )}
        {sentNote && <div className="muted" style={{ fontSize: 'var(--fs-xs)', textAlign: 'center' }}>{sentNote}</div>}
      </div>

      <div className="scan__bottom" style={{ justifyContent: 'center', gap: 10 }}>
        {!focused ? (
          <button className="scan__go" onClick={start} disabled={starting || !!camError || ready === null} aria-label="Start"><Play size={18} strokeWidth={3} /><span>{starting ? 'Focus' : 'Start'}</span></button>
        ) : (
          <button className="scan__go" onClick={scan} disabled={busy || !!camError || !card} aria-label="Scan this card"><Camera size={18} strokeWidth={3} /><span>{busy ? `Reading ${progress}/${BENCH_ATTEMPTS}` : `Scan ×${BENCH_ATTEMPTS}`}</span></button>
        )}
        <button className="btn btn--sm" style={{ background: 'rgba(7,20,17,.8)', color: 'var(--text)' }} onClick={send} disabled={sending || done === 0}>{companionConnected() ? <Send size={14} /> : <Share2 size={14} />} {sending ? 'Sending' : 'Send to Desk'}</button>
      </div>

      {/* Deck editor */}
      <Sheet open={editing} onClose={() => setEditing(false)}>
        <div className="stack">
          <div className="row row--between">
            <span className="title title--sm">Test deck</span>
            <div className="row" style={{ gap: 6 }}>
              {benchCards && <button className="btn btn--sm btn--ghost" onClick={resetDeck}>Reset</button>}
              <button className="btn btn--sm btn--ghost" onClick={() => { setEditing(false); setUnlisted({ name: '', number: '', finish: 'normal', ja: false }) }}>Unlisted</button>
              <button className="btn btn--sm btn--accent" onClick={() => { setEditing(false); setAdding(true) }}><Plus size={14} /> Add card</button>
            </div>
          </div>
          <div className="stack" style={{ gap: 6 }}>
            {deck.map((c, i) => (
              <div key={`${c.expected[0] ?? c.name}-${i}`} className="row row--between card-panel" style={{ padding: '8px 10px' }}>
                <div style={{ minWidth: 0 }}>
                  <div className="list__title">{i + 1}. {c.name}</div>
                  <div className="list__sub">{c.number} · {c.finish === 'normal' ? 'standard' : c.finish === 'reverse' ? 'reverse holo' : c.finish}{c.note ? ` · ${c.note}` : ''}</div>
                </div>
                <button className="iconbtn iconbtn--ghost" onClick={() => removeCard(i)} aria-label={`Remove ${c.name}`}><Trash2 size={18} /></button>
              </div>
            ))}
          </div>
        </div>
      </Sheet>
      <SearchSheet open={adding} onClose={() => setAdding(false)} onPick={(id) => void pickCard(id)} />
      <Sheet open={!!pending} onClose={() => setPending(null)}>
        {pending && (
          <div className="stack">
            <span className="title title--sm">Which finish is your copy?</span>
            <div><div className="list__title">{pending.name}</div><div className="list__sub">{pending.number}</div></div>
            <Segmented id="pending-finish" value={pending.finish} onChange={(f) => setPending({ ...pending, finish: f })} options={pending.options.map((f) => ({ value: f, label: FINISH_LABEL[f] }))} />
            <button className="btn btn--accent btn--block" onClick={addPending}><Plus size={18} /> Add to the deck</button>
          </div>
        )}
      </Sheet>
      <Sheet open={!!unlisted} onClose={() => setUnlisted(null)}>
        {unlisted && (
          <div className="stack">
            <span className="title title--sm">A card the catalogue lacks</span>
            <p style={{ margin: 0, color: 'var(--muted)', fontSize: 'var(--fs-sm)', lineHeight: 1.3 }}>The scanner cannot match it; the bench records what it reads, and counts a read as right when nothing is committed.</p>
            <input className="input" autoFocus placeholder="Name as printed" value={unlisted.name} onChange={(e) => setUnlisted({ ...unlisted, name: e.target.value })} />
            <input className="input mono" placeholder="Number and set code as printed" value={unlisted.number} onChange={(e) => setUnlisted({ ...unlisted, number: e.target.value })} />
            <Segmented id="unlisted-lang" value={unlisted.ja ? 'ja' : 'en'} onChange={(v) => setUnlisted({ ...unlisted, ja: v === 'ja' })} options={[{ value: 'en', label: 'English' }, { value: 'ja', label: 'Japanese' }]} />
            <Segmented id="unlisted-finish" value={unlisted.finish} onChange={(f) => setUnlisted({ ...unlisted, finish: f })} options={(['normal', 'reverse', 'holo'] as Finish[]).map((f) => ({ value: f, label: FINISH_LABEL[f] }))} />
            <button className="btn btn--accent btn--block" onClick={addUnlisted} disabled={!unlisted.name.trim()}><Plus size={18} /> Add to the deck</button>
          </div>
        )}
      </Sheet>
    </div>
  )
}
