import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Zap, ZapOff, Search, Plus, Minus, X, ChevronLeft, Sun, SlidersHorizontal, SwitchCamera, ZoomIn, Focus, Play, Square, Sparkles, Check, Eye } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../data/db'
import type { CardRecord, IndexEntry, ScanEvent } from '../data/types'
import { startCamera, type CameraHandle } from '../recognition/camera'
import { FrameAnalyzer, Pacer, type Phase, type Roi } from '../recognition/frameAnalyzer'
import { captureRoi, recognize, isBlank, setNameOf, contrastOf, MIN_CONTRAST, type Recognition } from '../recognition/recognizer'
import { sharpnessOf, sharpnessOfVideo, BLUR_THRESHOLD } from '../recognition/focus'
import { warmOcr, ocrJobs, recycleOcrIfNeeded } from '../recognition/ocr'
import { loadIndex, getCard } from '../api/tcgdex'
import { searchIndex } from '../recognition/matcher'
import { applyScan, setFinishOne, cardValueAud } from '../store/collection'
import { finishesOf, FINISH_LABEL, rarityTag, defaultFinish } from '../data/finish'
import type { Finish } from '../data/types'
import { useSettings } from '../store/settings'
import { sendCompanion } from '../sync/companion'
import { buzz, chime } from '../utils/haptics'
import { fmtAud } from '../utils/price'
import { Particles, PALETTES } from '../components/Particles'
import { CardImage, prefetchCardImage, Sheet, STATUS_WORD, toast } from '../components/ui'
import { CardDetailSheet } from '../components/CardDetail'

type Result = { ev: ScanEvent; card: CardRecord; rec: Recognition }

/** Short name for a lens: "0" / "2" on Android ("camera2 0, facing back"), "Wide" / "Ultra" on iOS. */
function lensName(devices: { id: string; label: string }[], id: string | null): string {
  const i = devices.findIndex((d) => d.id === id)
  const label = devices[i]?.label ?? ''
  const m = label.match(/camera2?\s*(\d+)/i)
  if (m) return m[1]
  if (/ultra/i.test(label)) return 'Ultra'
  if (/tele/i.test(label)) return 'Tele'
  if (/wide|back camera/i.test(label)) return 'Wide'
  return String(i + 1)
}

/** Colour and word for a scan outcome. */
function outcome(ev: ScanEvent): { word: string; color: string } {
  if (ev.action === 'remove') return { word: 'Removed', color: 'var(--danger)' }
  if (ev.highValue) return { word: 'High value', color: 'var(--value)' }
  if (ev.artistStatus === 'collecting') return { word: STATUS_WORD.collecting, color: 'var(--accent)' }
  if (ev.artistStatus === 'unknown') return { word: STATUS_WORD.unknown, color: 'var(--new)' }
  return { word: STATUS_WORD['not-collecting'], color: 'var(--text-2)' }
}

export default function Scan() {
  const nav = useNavigate()
  const videoRef = useRef<HTMLVideoElement>(null)
  const fxRef = useRef<HTMLCanvasElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const cam = useRef<CameraHandle | null>(null)
  const analyzer = useRef(new FrameAnalyzer())
  const pacer = useRef(new Pacer(10))
  const particles = useRef<Particles | null>(null)
  const busy = useRef(false)
  const [phase, setPhase] = useState<Phase>('settling')
  const [camError, setCamError] = useState<string | null>(null)
  const [torch, setTorch] = useState(false)
  const [exposure, setExposure] = useState(0)          // EV steps: 0, -1, -2 (glare)
  const [camInfo, setCamInfo] = useState<{ exposure: boolean; zoom: boolean; focus: boolean; manual: { min: number; max: number; step: number } | null; devices: number; label: string; lens: string } | null>(null)
  const [tune, setTune] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [focusDist, setFocusDist] = useState<number | null>(null)
  const [blurry, setBlurry] = useState(false)
  const [running, setRunning] = useState(false)            // scanning is armed (Start pressed)
  const [starting, setStarting] = useState(false)          // calibrating focus after Start
  const runningRef = useRef(false)
  const [note, setNote] = useState<string | null>(null)     // brief hint: No card / Same card / Can't read
  const [, setTick] = useState(0)                           // re-render for the debug overlay
  const liveSharp = useRef(0)
  const sharpHist = useRef<number[]>([])                   // recent sharpness samples while settling
  const settleStart = useRef(0)
  const scanPeak = useRef(0)                               // best sharpness of a confident scan on this lens
  const lastRefocus = useRef(0)
  const lastSharpAt = useRef(0)
  const lastDebugTick = useRef(0)
  const lastCommit = useRef<{ id: string; at: number } | null>(null)
  const lastCapture = useRef<{ ms: number; ocrMs: number; tries: number } | null>(null)
  const pausedRef = useRef(false)                          // a sheet is waiting for an answer
  const [ask, setAsk] = useState<{ card: CardRecord; rec: Recognition; options: Finish[]; guess: Finish } | null>(null)
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [result, setResult] = useState<Result | null>(null)  // the card that is sitting in the jig right now
  const [view, setView] = useState(false)                    // the result's full detail sheet
  const [miss, setMiss] = useState<Recognition | null>(null)
  const [search, setSearch] = useState(false)
  const [flash, setFlash] = useState<string | null>(null)
  const [debug, setDebug] = useState(false)
  const [indexReady, setIndexReady] = useState<boolean | null>(null)
  const mode = useSettings((s) => s.scanMode)
  const setSettings = useSettings((s) => s.set)
  const [lensRequest, setLensRequest] = useState(0)        // bump to reopen the camera on the chosen lens
  const { sound, haptics } = useSettings()
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
    setCamError(null)
    startCamera(v, { deviceId: useSettings.getState().cameraId || null, hiRes: useSettings.getState().hiRes }).then((h) => {
      if (!alive) { h.stop(); return }
      cam.current = h
      // Remember the lens that opened, so every later start goes straight to it.
      if (h.deviceId && h.deviceId !== useSettings.getState().cameraId) useSettings.getState().set({ cameraId: h.deviceId })
      analyzer.current.reset()
      setCamInfo({
        exposure: !!h.exposureRange,
        zoom: !!h.zoomRange,
        focus: h.focusModes.length > 0,
        manual: h.focusRange,
        devices: h.devices.length,
        label: h.devices.find((d) => d.id === h.deviceId)?.label ?? '',
        lens: lensName(h.devices, h.deviceId),
      })
      setZoom(1); setFocusDist(null); setExposure(0); setTorch(false)
      runningRef.current = false; setRunning(false)
      scanPeak.current = 0
      layoutFrame()
    }).catch((e) => { if (alive) setCamError(e?.message ?? 'Camera unavailable') })
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
  }, [layoutFrame, lensRequest])

  /** How the camera judges focus: sharpness of the text bands in the guide region. */
  const focusOpts = useCallback(() => ({
    measure: () => (videoRef.current ? sharpnessOfVideo(videoRef.current, roi()) : 0),
    // "good" is the same bar the scan gate uses: the floor, or well within this lens's best
    good: Math.max(BLUR_THRESHOLD, Math.max(cam.current?.focusPeak() ?? 0, scanPeak.current) * 0.6),
  }), [roi])
  /** Soft when under the fixed floor, or well below the best this lens has shown (autofocus mid-hunt, stack getting shorter). */
  const isSoft = (s: number) => s < BLUR_THRESHOLD || s < Math.max(cam.current?.focusPeak() ?? 0, scanPeak.current) * 0.5

  // Hands-free analysis loop. Base rate ~5 fps waiting, ~6 fps while a card settles; the
  // frame is drawn and read back once per tick (stage.ts) and the Pacer stretches the
  // interval whenever a tick costs more than ~10 ms or the page itself starts to jank.
  useEffect(() => {
    let raf = 0
    let last = 0
    let wasSettling = false
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick)
      const a = analyzer.current
      const pace = pacer.current
      pace.frame(t)
      const base = a.phase === 'settling' ? 160 : 200
      if (t - last < pace.interval(base)) return
      last = t
      const v = videoRef.current
      if (!v || !cam.current || busy.current || !runningRef.current || pausedRef.current) return
      const t0 = performance.now()
      const fire = a.step(v, roi(), t)
      setPhase(a.phase)
      const settling = a.phase === 'settling' || a.phase === 'capture'
      if (settling && !wasSettling) { settleStart.current = t; sharpHist.current = [] }
      wasSettling = settling
      // While the picture is settling, watch the focus (from the frame step() already read).
      let empty = false
      if (settling) {
        const s = a.sharpness()
        liveSharp.current = s
        lastSharpAt.current = t
        sharpHist.current = [...sharpHist.current.slice(-3), s]
        // Nothing printed in the frame (the jig after the last card): there is nothing to
        // focus on and nothing to wait for; the read will say "No card" straight away.
        empty = a.contrast() < MIN_CONTRAST
        const soft = !empty && isSoft(s)
        setBlurry(soft || cam.current.focusing())
        // A continuous autofocus usually lands by itself; only kick it when the picture is
        // still soft after 1.2 s of stillness, and never more than once every 2.5 s.
        if (soft && t - settleStart.current > 1200 && t - lastRefocus.current > 2500 && !cam.current.focusing()) {
          lastRefocus.current = t
          // After the lens has moved, look at the card afresh (settle again, then scan).
          void cam.current.refocus(focusOpts()).then((moved) => { if (moved) { analyzer.current.reset(); settleStart.current = performance.now(); sharpHist.current = [] } })
        }
      } else setBlurry(cam.current.focusing())
      if (debug) {
        if (!settling && t - lastSharpAt.current > 500) { lastSharpAt.current = t; liveSharp.current = a.sharpness(); setTick((n) => n + 1) }
        else if (settling && t - lastDebugTick.current > 400) { lastDebugTick.current = t; setTick((n) => n + 1) }
      }
      pace.worked(performance.now() - t0, base)
      if (fire) {
        const overdue = t - settleStart.current > 2500
        // Mid-sweep frame: let the sweep finish and look again shortly (never drop the
        // capture: dropping it on an empty jig re-settled forever).
        if (cam.current.focusing() && !overdue) { a.postpone(t, 200); return }
        // The hand has gone, but the autofocus may still be converging: require a plateau
        // over the last three sharpness samples (within 15%) before reading, up to 2.5 s.
        const h = sharpHist.current
        const n = h.length
        const last3 = h.slice(-3)
        const stable = n >= 3 && Math.max(...last3) <= 1.15 * Math.max(Math.min(...last3), 1e-3)
        const ready = empty || (stable && !isSoft(h[n - 1]))   // agreeing samples at the bottom of a focus hunt are not "stable"
        if (ready || overdue) void captureRef.current()
        else a.postpone(t, 160)
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [roi, debug])

  const feedback = (kind: 'ok' | 'alert' | 'remove' | 'fail', pattern: number | number[]) => {
    if (sound) chime(kind)
    if (haptics) buzz(pattern)
  }

  const burstAt = (palette: string[], power = 1) => {
    const p = particles.current, f = frameBox
    if (!p || !f) return
    p.clear()
    p.burst(f.left + f.width / 2, f.top + f.height / 2, palette, 110, power)
    p.ring(f.left + f.width / 2, f.top + f.height / 2, Math.min(f.width, f.height) * 0.45, palette)
  }

  const { askFinish, effects } = useSettings()

  /**
   * Work out the finish. The foil read tells a standard print from a reverse holo
   * (body texture); it cannot tell a holo rare from its reverse (both bodies are foil),
   * so cards without a standard print still ask.
   */
  const decideFinish = (card: CardRecord, rec: Recognition): { finish: Finish; ask: false } | { finish: Finish; ask: true; options: Finish[] } => {
    const options = finishesOf(card)
    if (options.length === 1) return { finish: options[0], ask: false }
    const foil = rec.foil
    const plain = options.filter((f) => f !== 'reverse')
    const standardOrReverse = options.includes('reverse') && plain.length === 1 && plain[0] === 'normal'
    if (standardOrReverse && foil?.confident) return { finish: foil.guess, ask: false }
    const guess: Finish = standardOrReverse && foil ? foil.guess : options.includes('reverse') && plain.length ? plain[0] : defaultFinish(card)
    return askFinish ? { finish: guess, ask: true, options } : { finish: guess, ask: false }
  }

  const commit = useCallback(async (card: CardRecord, rec: Recognition, finishIn?: Finish) => {
    let finish = finishIn
    if (!finish) {
      const d = decideFinish(card, rec)
      if (d.ask) { pausedRef.current = true; setAsk({ card, rec, options: d.options, guess: d.finish }); return }
      finish = d.finish
    }
    const ev = await applyScan(card, mode, finish)
    const palette = mode === 'remove' ? PALETTES.remove : ev.highValue ? PALETTES.value : PALETTES[ev.artistStatus]
    if (effects) {
      burstAt(palette, ev.highValue ? 1.5 : 1)
      setFlash(mode === 'remove' ? 'var(--danger)' : ev.highValue ? 'var(--value)' : ev.artistStatus === 'collecting' ? 'var(--accent)' : ev.artistStatus === 'unknown' ? 'var(--new)' : 'transparent')
      setTimeout(() => setFlash(null), 350)
    }
    if (mode === 'remove') feedback('remove', [30, 40, 30])
    else if (ev.highValue) feedback('alert', [40, 60, 40, 60, 120])
    else feedback('ok', ev.artistStatus === 'collecting' ? [25, 40, 25] : 25)
    sendCompanion({ type: 'scan', scan: ev })
    lastCommit.current = { id: card.id, at: Date.now() }
    setNote(null)
    setResult({ ev, card, rec })
  }, [mode, frameBox, sound, haptics, askFinish, effects])

  const answerFinish = async (finish: Finish) => {
    const a = ask
    setAsk(null)
    pausedRef.current = false
    if (!a) return
    busy.current = true
    try { await commit(a.card, a.rec, finish) } finally { busy.current = false }
  }

  /** Tap the finish chip on the result: step through the finishes this card exists in. */
  const cycleFinish = async () => {
    const r = result
    if (!r?.ev.ownedId) return
    const opts = finishesOf(r.card)
    if (opts.length < 2) return
    const next: Finish = opts[(opts.indexOf(r.ev.finish ?? 'normal') + 1) % opts.length]
    const ownedId = await setFinishOne(r.ev.ownedId, next)
    const valueAud = await cardValueAud(r.card, next)
    setResult({ ...r, ev: { ...r.ev, finish: next, ownedId, valueAud } })
  }

  const showNote = (text: string) => {
    setNote(text)
    if (noteTimer.current) clearTimeout(noteTimer.current)
    noteTimer.current = setTimeout(() => setNote(null), 1600)
  }

  const capture = useCallback(async () => {
    const v = videoRef.current
    if (!v || busy.current) return
    busy.current = true
    const t0 = performance.now()
    let softMiss = false
    let tries = 1
    let rec: Recognition | null = null
    try {
      let frame = captureRoi(v, roi())
      let sharp = sharpnessOf(frame)
      if (isSoft(sharp) && cam.current && contrastOf(frame) >= MIN_CONTRAST) {
        // Soft frame: get the lens focused (autofocus pass or distance sweep), then give it
        // up to a second to land before looking again. Reading a soft frame is slow and useless.
        lastRefocus.current = performance.now()
        setBlurry(true)
        await cam.current.refocus(focusOpts())
        const until = performance.now() + 1000
        do {
          await new Promise((r) => setTimeout(r, 150))
          const again = captureRoi(v, roi(), frame)
          const s2 = sharpnessOf(again)
          if (s2 > sharp) { frame = again; sharp = s2 }
        } while (isSoft(sharp) && performance.now() < until)
        setBlurry(false)
      }
      rec = await recognize(frame, { debug })
      // Foil and glare change frame to frame: before giving up, read up to two more
      // frames, pooling their OCR text with what has been read so far. A frame with a
      // card in it that read as nothing (foil over the number, patterned reverse) is
      // retried too; only an empty frame or a soft one is not.
      for (let attempt = 0; attempt < 2 && !rec.card && !rec.empty && !isSoft(rec.sharpness); attempt++) {
        await new Promise((r) => setTimeout(r, 200))
        tries++
        const again = await recognize(captureRoi(v, roi()), { debug, prior: rec })
        rec = again.empty ? rec : again
      }
      const a = analyzer.current
      if (rec.card) {
        prefetchCardImage(rec.card.image, 'low'); prefetchCardImage(rec.card.image, 'high')
        const last = lastCommit.current
        const same = last && last.id === rec.card.id && a.change < 0.05 && Date.now() - last.at < 20000
        if (same) showNote('Same card')   // nothing moved: a hand passed over, not a new card
        else {
          if (rec.confidence >= 0.8) scanPeak.current = Math.max(scanPeak.current, rec.sharpness)
          await commit(rec.card, rec)
        }
      } else if (isSoft(rec.sharpness) && rec.sharpness > 0) {
        softMiss = true                                  // the lens was still moving: try this card again
      } else if (rec.empty) {
        setResult(null)                                  // the card is gone
        showNote(a.scans <= 1 ? 'Ready' : 'No card')   // empty jig, table
      } else if (isBlank(rec)) {
        setResult(null)
        feedback('fail', 60)
        showNote("Can't read")                           // something is there, but no number or name came out
      } else {
        setResult(null)
        feedback('fail', 60)
        pausedRef.current = true
        setMiss(rec)
      }
    } catch (e: any) {
      toast(e?.message ?? 'Scan failed')
    } finally {
      lastCapture.current = { ms: performance.now() - t0, ocrMs: rec?.ocrMs ?? 0, tries }
      if (softMiss) analyzer.current.retry()
      else analyzer.current.release()
      busy.current = false
      void recycleOcrIfNeeded()
    }
  }, [roi, commit, debug, focusOpts])

  const cycleExposure = async () => {
    if (!cam.current?.exposureRange) return
    const next = exposure <= -2 ? 0 : exposure - 1
    const { min, step } = cam.current.exposureRange
    // -1 "step" = one third of the range below zero, so it works on any device scale
    const ev = next === 0 ? 0 : Math.max(min, Math.round((next * Math.abs(min) / 3) / step) * step)
    if (await cam.current.setExposure(ev)) setExposure(next)
  }

  /** Start: calibrate focus on the card sitting in the jig, then arm hands-free scanning. */
  const start = async () => {
    if (!cam.current || starting) return
    setStarting(true); setBlurry(true)
    try { await cam.current.refocus({ ...focusOpts(), full: true }) } catch { /* ignore */ }
    setBlurry(false); setStarting(false)
    analyzer.current.reset()
    runningRef.current = true; setRunning(true)
  }
  const stop = () => {
    runningRef.current = false; setRunning(false)
    setBlurry(false); setNote(null); setResult(null)
  }

  // The analysis loop is a long-lived effect: always call the latest capture (mode, debug flag, …).
  const captureRef = useRef(capture)
  captureRef.current = capture

  const cycleZoom = async () => {
    const r = cam.current?.zoomRange
    if (!r) return
    const steps = [1, 1.5, 2, 3].filter((z) => z <= r.max && z >= r.min)
    const next = steps[(steps.indexOf(zoom) + 1) % steps.length] ?? 1
    if (await cam.current!.setZoom(next)) setZoom(next)
  }

  const refocus = async () => {
    if (!cam.current) return
    if (focusDist != null) { await cam.current.setFocusDistance(null); setFocusDist(null) }
    lastRefocus.current = performance.now()
    setBlurry(true)
    await cam.current.refocus(focusOpts())
    setBlurry(false)
    setTick((n) => n + 1)
  }

  const setManualFocus = async (d: number) => {
    if (!cam.current) return
    if (await cam.current.setFocusDistance(d)) setFocusDist(d)
  }

  const hiRes = useSettings((s) => s.hiRes)
  const toggleRes = () => {
    setSettings({ hiRes: !hiRes })
    setLensRequest((n) => n + 1)   // reopen the camera at the new size
  }

  const switchCamera = () => {
    const h = cam.current
    if (!h || h.devices.length < 2) return
    const i = h.devices.findIndex((d) => d.id === h.deviceId)
    const next = h.devices[(i + 1) % h.devices.length]
    setSettings({ cameraId: next.id })
    setLensRequest((n) => n + 1)   // the camera effect restarts the stream
  }

  const pickAlternative = async (id: string) => {
    const rec = miss
    setMiss(null)
    pausedRef.current = false
    const card = await getCard(id)
    busy.current = true
    try { await commit(card, rec ?? ({} as Recognition)) } finally { busy.current = false }
  }

  const toggleTorch = async () => {
    if (!cam.current) return
    const on = await cam.current.torch(!torch)
    setTorch(on)
  }

  const openView = () => { if (result) { pausedRef.current = true; setView(true) } }
  const closeView = () => { setView(false); pausedRef.current = false }

  const lastRec = result?.rec ?? miss
  // The scanned card is "present" while the analyzer sees the frame it scanned; it goes
  // stale the moment something moves (card being pulled, the next one settling).
  const stale = phase === 'settling' || phase === 'capture'
  const found = result && !stale
  const out = result ? outcome(result.ev) : null
  const statusWord = ask ? 'Finish?' : miss ? 'Not sure' : blurry ? 'Focus' : !running ? 'Paused' : phase === 'capture' || busy.current ? 'Reading' : phase === 'settling' ? 'Hold' : found ? 'Scanned' : 'Ready'
  const dotClass = !running && !blurry ? '' : phase === 'settling' || blurry ? 'scan__dot--hold' : phase === 'capture' || busy.current ? 'scan__dot--busy' : 'scan__dot--on'
  const camSettings = cam.current?.settings() ?? {}
  const heapMb = (performance as any).memory?.usedJSHeapSize ? ((performance as any).memory.usedJSHeapSize / 1048576).toFixed(0) : '-'
  const tagTop = frameBox ? Math.min(frameBox.top + frameBox.height + 10, window.innerHeight - 118 - 100) : 0

  return (
    <div className="scan" onDoubleClick={() => setDebug((d) => !d)}>
      <video ref={videoRef} playsInline muted autoPlay />
      <AnimatePresence>
        {flash && <motion.div className="scan__flash" style={{ background: flash }} initial={{ opacity: 0.35 }} animate={{ opacity: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.35 }} />}
      </AnimatePresence>

      {frameBox && (
        <>
          <div className="scan__dim" style={{ left: 0, top: 0, right: 0, height: frameBox.top }} />
          <div className="scan__dim" style={{ left: 0, top: frameBox.top + frameBox.height, right: 0, bottom: 0 }} />
          <div className="scan__dim" style={{ left: 0, top: frameBox.top, width: frameBox.left, height: frameBox.height }} />
          <div className="scan__dim" style={{ left: frameBox.left + frameBox.width, top: frameBox.top, right: 0, height: frameBox.height }} />
        </>
      )}
      {frameBox && (
        <div
          ref={frameRef}
          className={`scan__frame ${phase === 'settling' ? 'scan__frame--hold' : ''} ${phase === 'capture' || busy.current ? 'scan__frame--busy' : ''} ${mode === 'remove' ? 'scan__frame--remove' : ''} ${found ? 'scan__frame--found' : ''}`}
          style={{ ...frameBox, ...(found && out ? { borderColor: out.color } : {}) }}
        >
          <i className="scan__corner tl" /><i className="scan__corner tr" /><i className="scan__corner bl" /><i className="scan__corner br" />
          {/* Badge on the card itself: this is the card that was just scanned, not a new one */}
          {found && out && (
            <div className="scan__badge" style={{ background: out.color, color: out.color === 'var(--text-2)' ? 'var(--bg)' : out.color === 'var(--value)' ? 'var(--value-ink)' : out.color === 'var(--danger)' ? 'var(--danger-ink)' : out.color === 'var(--new)' ? 'var(--new-ink)' : 'var(--accent-ink)' }}>
              <Check size={14} strokeWidth={3.5} /> {note ?? out.word}
            </div>
          )}
        </div>
      )}
      {frameBox && !result && note && (
        <div className="scan__hint" style={{ top: frameBox.top + frameBox.height + 14 }}>{note}</div>
      )}
      {frameBox && !result && !note && running && phase === 'idle' && analyzer.current.scans > 0 && (
        <div className="scan__hint" style={{ top: frameBox.top + frameBox.height + 14 }}>Next card</div>
      )}

      {/* The scanned card's details, pinned under the frame for as long as the card sits there */}
      <AnimatePresence>
        {frameBox && result && out && (
          <motion.div
            key={result.ev.id ?? result.card.id}
            className={`scan__tag ${stale ? 'scan__tag--stale' : ''}`}
            style={{ top: tagTop }}
            initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: { duration: 0.12 } }}
            transition={{ duration: 0.2 }}
          >
            <button className="scan__tagart" onClick={openView} aria-label="View card">
              <CardImage src={result.card.image} alt={result.card.name} eager />
            </button>
            <div className="scan__tagbody">
              <div className="scan__tagword" style={{ color: out.color }}>{stale ? 'Card moved' : out.word}</div>
              <div className="scan__tagname">{result.card.name}</div>
              <div className="scan__tagsub">{result.card.illustrator ?? 'Unknown artist'} · {result.card.localId}/{result.card.setTotal || '?'}</div>
              <div className="row" style={{ gap: 6, marginTop: 4 }}>
                <button
                  className={`chip ${result.ev.finish && result.ev.finish !== 'normal' ? 'chip--unknown' : 'chip--outline'}`}
                  style={{ height: 26, fontSize: 'var(--fs-xs)' }}
                  onClick={() => void cycleFinish()}
                  aria-label="Finish"
                >
                  {FINISH_LABEL[result.ev.finish ?? 'normal']}{finishesOf(result.card).length > 1 ? ' ⇄' : ''}
                </button>
                {rarityTag(result.card.rarity) && <span className="chip chip--outline" style={{ height: 26, fontSize: 'var(--fs-xs)' }}>{rarityTag(result.card.rarity)}</span>}
                <span className={`scan__tagvalue ${result.ev.highValue ? 'scan__tagvalue--hot' : ''}`}>{fmtAud(result.ev.valueAud)}</span>
              </div>
            </div>
            <button className="scan__tagview" onClick={openView} aria-label="View card"><Eye size={20} /></button>
          </motion.div>
        )}
      </AnimatePresence>

      <canvas ref={fxRef} className="fx" />

      <div className="scan__top">
        <button className="iconbtn iconbtn--ghost" style={{ background: 'rgba(7,20,17,.6)' }} onClick={() => nav(-1)} aria-label="Back"><ChevronLeft /></button>
        <div className="scan__status">
          <span className={`scan__dot ${dotClass}`} />
          {camError ? 'No camera' : indexReady === false ? 'Offline' : statusWord}
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="iconbtn iconbtn--ghost" style={{ background: 'rgba(7,20,17,.6)', color: tune || zoom !== 1 || exposure || focusDist != null ? 'var(--accent)' : undefined }} onClick={() => setTune((t) => !t)} aria-label="Camera settings">
            <SlidersHorizontal />
          </button>
          <button className="iconbtn iconbtn--ghost" style={{ background: 'rgba(7,20,17,.6)', color: torch ? 'var(--accent)' : undefined }} onClick={toggleTorch} aria-label="Torch" disabled={!cam.current?.hasTorch}>
            {torch ? <Zap /> : <ZapOff />}
          </button>
        </div>
      </div>

      <AnimatePresence>
        {tune && camInfo && (
          <motion.div className="scan__tune" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.18 }}>
            <div className="scan__tunerow">
              <button className={`scan__tunebtn ${focusDist == null ? '' : 'on'}`} onClick={refocus} aria-label="Focus"><Focus size={20} /><span>Focus</span></button>
              {camInfo.zoom && (
                <button className={`scan__tunebtn ${zoom !== 1 ? 'on' : ''}`} onClick={cycleZoom} aria-label="Zoom"><ZoomIn size={20} /><span>{zoom}×</span></button>
              )}
              {camInfo.exposure && (
                <button className={`scan__tunebtn ${exposure ? 'on' : ''}`} onClick={cycleExposure} aria-label="Glare"><Sun size={20} /><span>{exposure ? `${exposure} EV` : 'Glare'}</span></button>
              )}
              {camInfo.devices > 1 && (
                <button className="scan__tunebtn" onClick={switchCamera} aria-label="Switch lens"><SwitchCamera size={20} /><span>Lens {camInfo.lens}</span></button>
              )}
              <button className={`scan__tunebtn ${hiRes ? 'on' : ''}`} onClick={toggleRes} aria-label="Resolution"><Focus size={20} /><span>{hiRes ? '4K' : 'HD'}</span></button>
              <button className={`scan__tunebtn ${effects ? '' : 'on'}`} onClick={() => setSettings({ effects: !effects })} aria-label="Effects"><Sparkles size={20} /><span>{effects ? 'FX on' : 'Lite'}</span></button>
            </div>
            {camInfo.manual && (
              <div className="scan__tunerow" style={{ paddingTop: 0 }}>
                <input
                  className="range"
                  type="range"
                  min={camInfo.manual.min}
                  max={camInfo.manual.max}
                  step={camInfo.manual.step}
                  value={focusDist ?? camSettings.focusDistance ?? camInfo.manual.min}
                  onChange={(e) => void setManualFocus(parseFloat(e.target.value))}
                  aria-label="Manual focus"
                />
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {debug && (
        <div className="scan__ocr" style={{ bottom: 110 }}>
          {`${videoRef.current?.videoWidth ?? 0}x${videoRef.current?.videoHeight ?? 0} focus=${camSettings.focusMode ?? '-'}${camSettings.focusDistance != null ? `@${camSettings.focusDistance}` : ''} zoom=${camSettings.zoom ?? '-'} modes=${cam.current?.focusModes.join(',') || '-'} cam="${camInfo?.label ?? ''}"\n`}
          {`page ${(1000 / Math.max(1, pacer.current.gap)).toFixed(0)}fps tick=${pacer.current.cost.toFixed(1)}ms x${pacer.current.factor.toFixed(2)} heap=${heapMb}MB ocrJobs=${ocrJobs()} last=${lastCapture.current ? `${lastCapture.current.ms.toFixed(0)}ms (ocr ${lastCapture.current.ocrMs.toFixed(0)}ms, ${lastCapture.current.tries} read${lastCapture.current.tries > 1 ? 's' : ''})` : '-'}\n`}
          {`phase=${phase} motion=${analyzer.current.motion.toFixed(3)} change=${analyzer.current.change.toFixed(3)} sharp=${liveSharp.current.toFixed(3)} (min ${BLUR_THRESHOLD}, peak ${Math.max(cam.current?.focusPeak() ?? 0, scanPeak.current).toFixed(3)}) scans=${analyzer.current.scans}\n`}
          {lastRec ? `top="${lastRec.ocr?.top}"\nbottom="${lastRec.ocr?.bottom}"\ncorner="${lastRec.ocr?.corner}"\n${lastRec.ms?.toFixed(0)}ms conf=${lastRec.confidence?.toFixed(2)} sharp=${lastRec.sharpness?.toFixed(3)} foil=${lastRec.foil ? `${lastRec.foil.ratio.toFixed(2)} (body ${lastRec.foil.body.toFixed(4)} border ${lastRec.foil.border.toFixed(4)} → ${lastRec.foil.guess}${lastRec.foil.confident ? '' : '?'})` : '-'} num=${lastRec.parsed?.number ?? '-'}/${lastRec.parsed?.total ?? '-'} name=${lastRec.parsed?.nameGuess ?? ''} illus=${lastRec.parsed?.illustratorGuess ?? '-'}` : ''}
          {lastRec?.bands && (
            <div style={{ marginTop: 6, display: 'grid', gap: 4 }}>
              <img src={lastRec.bands.top} style={{ width: '100%', border: '1px solid var(--line-strong)' }} alt="" />
              <img src={lastRec.bands.bottom} style={{ width: '100%', border: '1px solid var(--line-strong)' }} alt="" />
              <img src={lastRec.bands.corner} style={{ width: '60%', border: '1px solid var(--line-strong)' }} alt="" />
            </div>
          )}
        </div>
      )}

      <div className="scan__bottom">
        <div className="scan__mode">
          <button className={mode === 'add' ? 'on' : ''} onClick={() => setSettings({ scanMode: 'add' })}><Plus size={16} strokeWidth={3} /> Add</button>
          <button className={`${mode === 'remove' ? 'on remove' : ''}`} onClick={() => setSettings({ scanMode: 'remove' })}><Minus size={16} strokeWidth={3} /> Remove</button>
        </div>
        {running ? (
          <button className="scan__go scan__go--stop" onClick={stop} aria-label="Stop scanning"><Square size={16} strokeWidth={3} /><span className="mono">{todayCount}</span></button>
        ) : (
          <button className="scan__go" onClick={start} disabled={starting || !!camError} aria-label="Start scanning"><Play size={18} strokeWidth={3} /><span>{starting ? 'Focus' : 'Start'}</span></button>
        )}
        <button className="iconbtn" style={{ background: 'rgba(7,20,17,.72)' }} onClick={() => setSearch(true)} aria-label="Search"><Search /></button>
      </div>

      {/* Which finish? Stays until answered; scanning waits. */}
      <Sheet open={!!ask} onClose={() => { /* must answer */ }}>
        {ask && (
          <div className="stack">
            <div className="row row--between">
              <span className="title title--new title--sm">Which finish?</span>
            </div>
            <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
              <div style={{ width: 96, flex: 'none' }}><CardImage src={ask.card.image} alt={ask.card.name} /></div>
              <div className="stack" style={{ gap: 4 }}>
                <div className="list__title">{ask.card.name}</div>
                <div className="list__sub">{ask.card.setName} · {ask.card.localId}/{ask.card.setTotal || '?'}</div>
                {ask.rec.foil && <div className="muted mono" style={{ fontSize: 'var(--fs-xs)' }}>foil {ask.rec.foil.ratio.toFixed(2)}</div>}
              </div>
            </div>
            <div className="stack" style={{ gap: 8 }}>
              {ask.options.map((f) => (
                <button key={f} className={`btn btn--block ${f === ask.guess ? 'btn--accent' : ''}`} onClick={() => void answerFinish(f)}>{FINISH_LABEL[f]}{f === ask.guess ? ' · likely' : ''}</button>
              ))}
            </div>
          </div>
        )}
      </Sheet>

      {/* The scanned card in full, to check it is the right one */}
      <CardDetailSheet cardId={view && result ? result.card.id : null} onClose={closeView} />

      {/* Not recognised → pick from candidates or search */}
      <Sheet open={!!miss} onClose={() => { setMiss(null); pausedRef.current = false }}>
        {miss && (
          <div className="stack">
            <div className="row row--between">
              <span className="title title--grey title--sm">Not sure</span>
              <button className="iconbtn iconbtn--ghost" onClick={() => { setMiss(null); pausedRef.current = false }}><X /></button>
            </div>
            <div className="muted">
              Read{' '}
              <b className="mono" style={{ color: 'var(--text)' }}>{miss.parsed.number ? `${miss.parsed.number}${miss.parsed.total ? `/${miss.parsed.total}` : ''}` : 'no number'}</b>
              {miss.parsed.nameGuess ? <> · <b style={{ color: 'var(--text)' }}>{miss.parsed.nameGuess}</b></> : null}
              {miss.parsed.illustratorGuess ? <> · <b style={{ color: 'var(--text)' }}>{miss.parsed.illustratorGuess}</b></> : null}
            </div>
            {miss.bands && (
              <div className="stack" style={{ gap: 4 }}>
                <img src={miss.bands.top} style={{ width: '100%', border: '1px solid var(--line-strong)', borderRadius: 6 }} alt="" />
                <img src={miss.bands.bottom} style={{ width: '100%', border: '1px solid var(--line-strong)', borderRadius: 6 }} alt="" />
                <img src={miss.bands.corner} style={{ width: '70%', border: '1px solid var(--line-strong)', borderRadius: 6 }} alt="" />
                <div className="muted mono" style={{ fontSize: 10, wordBreak: 'break-all' }}>{`top="${miss.ocr.top}"
corner="${miss.ocr.corner}"
bottom="${miss.ocr.bottom}"
sharp=${miss.sharpness.toFixed(3)}`}</div>
              </div>
            )}
            {miss.alternatives.length > 0 ? (
              <div className="grid">
                {miss.alternatives.slice(0, 8).map((a) => <AltTile key={a.entry.id} entry={a.entry} onPick={() => pickAlternative(a.entry.id)} />)}
              </div>
            ) : (
              <div className="empty">No match</div>
            )}
            <button className="btn btn--accent btn--block" onClick={() => { setMiss(null); pausedRef.current = false; setSearch(true) }}><Search size={18} /> Search</button>
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
