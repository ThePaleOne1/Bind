import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Zap, ZapOff, Search, Plus, Minus, X, ChevronLeft, Sun, SlidersHorizontal, SwitchCamera, ZoomIn, Focus, Play, Square, Sparkles, Check, Eye, Send, Share2, Languages } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../data/db'
import { setCode, type CardRecord, type IndexEntry, type ScanEvent } from '../data/types'
import { startCamera, type CameraHandle } from '../recognition/camera'
import { FrameAnalyzer, Pacer, type Phase, type Roi } from '../recognition/frameAnalyzer'
import { recognize, isBlank, setNameOf, MIN_CONTRAST, type Recognition } from '../recognition/recognizer'
import { grabWide, locateCard } from '../recognition/pipeline'
import type { FoilRead } from '../recognition/foil'
import { sharpnessOfVideo, BLUR_THRESHOLD } from '../recognition/focus'
import { warmOcr, ocrJobs, recycleOcrIfNeeded } from '../recognition/ocr'
import { loadIndex, getCard } from '../api/tcgdex'
import { searchIndex } from '../recognition/matcher'
import { applyScan, setFinishOne, cardValueAud } from '../store/collection'
import { finishesOf, FINISH_LABEL, rarityTag, defaultFinish } from '../data/finish'
import type { Finish } from '../data/types'
import { useSettings } from '../store/settings'
import { sendCompanion, companionConnected } from '../sync/companion'
import { buzz, chime } from '../utils/haptics'
import { fmtAud } from '../utils/price'
import { samplePerf, logEvent, logScan, baseReport } from '../utils/perfLog'
import { BUILD } from '../pwa'
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
function outcome(ev: ScanEvent): { word: string; color: string; ink: string } {
  if (ev.action === 'remove') return { word: 'Removed', color: 'var(--danger)', ink: 'var(--danger-ink)' }
  if (ev.highValue) return { word: 'High value', color: 'var(--value)', ink: 'var(--value-ink)' }
  if (ev.artistStatus === 'collecting') return { word: STATUS_WORD.collecting, color: 'var(--accent)', ink: 'var(--accent-ink)' }
  if (ev.artistStatus === 'unknown') return { word: STATUS_WORD.unknown, color: 'var(--new)', ink: 'var(--new-ink)' }
  return { word: STATUS_WORD['not-collecting'], color: 'var(--text-2)', ink: 'var(--bg)' }
}

export default function Scan() {
  const nav = useNavigate()
  const videoRef = useRef<HTMLVideoElement>(null)
  const fxRef = useRef<HTMLCanvasElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const cam = useRef<CameraHandle | null>(null)
  const analyzer = useRef(new FrameAnalyzer())
  const pacer = useRef(new Pacer(0.15))
  const particles = useRef<Particles | null>(null)
  const busy = useRef(false)
  const [phase, setPhase] = useState<Phase>('settling')
  const [camError, setCamError] = useState<string | null>(null)
  const [torch, setTorch] = useState(false)
  const [exposure, setExposure] = useState(0)          // EV steps: 0, -1, -2 (glare)
  const [camInfo, setCamInfo] = useState<{ exposure: boolean; zoom: boolean; focus: boolean; manual: { min: number; max: number; step: number } | null; devices: number; label: string; lens: string; still: boolean } | null>(null)
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
  const settleStart = useRef(0)
  const recentSets = useRef<string[]>([])                  // sets of the last few commits: cards come in batches
  const lastFrame = useRef<HTMLCanvasElement | null>(null) // the card crop last read (for the report)
  // The last dozen card crops with what was read and what the user answered: the raw
  // material for calibrating the finish detector across lighting setups.
  type Crop = { i: number; at: number; jpeg: string; rec: Recognition; card?: string; outcome: string; foil?: FoilRead; sharp?: number }
  const crops = useRef<Crop[]>([])
  const cropSeq = useRef(0)
  const finishByRec = useRef(new WeakMap<Recognition, { finish: Finish; answered: boolean; options: Finish[] }>())
  const [same, setSame] = useState(false)                  // the last read found the card already on the tag
  const scanPeak = useRef(0)                               // recent best preview sharpness of a confident scan (decays)
  const lastRefocus = useRef(0)
  const lastDebugTick = useRef(0)
  const lastCommit = useRef<{ id: string; at: number } | null>(null)
  const lastResult = useRef<Result | null>(null)
  const lastCapture = useRef<{ ms: number; ocrMs: number; tries: number; still: boolean } | null>(null)
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

  // Guide region: card aspect 63:88 centred, 74% of the shorter side wide
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
  // Where the card actually is (from the last detection); the guide box until then.
  const track = useRef<Roi | null>(null)
  const scanRoi = useCallback((): Roi => track.current ?? roi(), [roi])
  /** The guide box grown by 15% each side: the region the card is looked for in. */
  const wideRoi = useCallback((): Roi => {
    const g = roi()
    const mx = g.w * 0.15, my = g.h * 0.15
    const x = Math.max(0, g.x - mx), y = Math.max(0, g.y - my)
    return { x, y, w: Math.min(1 - x, g.w + 2 * mx), h: Math.min(1 - y, g.h + 2 * my) }
  }, [roi])

  // Place the on-screen frame where the (tracked) card is
  const [frameBox, setFrameBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null)
  const layoutFrame = useCallback(() => {
    const v = videoRef.current
    if (!v || !v.videoWidth) return
    const r = scanRoi()
    const el = v.getBoundingClientRect()
    const vw = v.videoWidth, vh = v.videoHeight
    const scale = Math.max(el.width / vw, el.height / vh)
    const offX = (el.width - vw * scale) / 2, offY = (el.height - vh * scale) / 2
    setFrameBox({ left: offX + r.x * vw * scale, top: offY + r.y * vh * scale, width: r.w * vw * scale, height: r.h * vh * scale })
    particles.current?.resize()
  }, [scanRoi])

  // Camera lifecycle
  useEffect(() => {
    let alive = true
    const v = videoRef.current!
    warmOcr()
    loadIndex().then(() => alive && setIndexReady(true)).catch(() => alive && setIndexReady(false))
    setCamError(null)
    startCamera(v, { deviceId: useSettings.getState().cameraId || null, hiRes: useSettings.getState().preview4k }).then((h) => {
      if (!alive) { h.stop(); return }
      cam.current = h
      // Remember the lens that opened, so every later start goes straight to it.
      if (h.deviceId && h.deviceId !== useSettings.getState().cameraId) useSettings.getState().set({ cameraId: h.deviceId })
      analyzer.current.reset()
      track.current = null
      setCamInfo({
        exposure: !!h.exposureRange,
        zoom: !!h.zoomRange,
        focus: h.focusModes.length > 0,
        manual: h.focusRange,
        devices: h.devices.length,
        label: h.devices.find((d) => d.id === h.deviceId)?.label ?? '',
        lens: lensName(h.devices, h.deviceId),
        still: h.canStill(),
      })
      setZoom(1); setFocusDist(null); setExposure(0); setTorch(false)
      runningRef.current = false; setRunning(false)
      scanPeak.current = 0
      layoutFrame()
      logEvent('camera', `${v.videoWidth}x${v.videoHeight} ${h.devices.find((d) => d.id === h.deviceId)?.label ?? ''} still=${h.canStill()}`)
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

  /** How the camera judges focus: sharpness of the text bands in the (tracked) card region of the preview. */
  const focusOpts = useCallback(() => ({
    measure: () => (videoRef.current ? sharpnessOfVideo(videoRef.current, scanRoi()) : 0),
    // "good" is the same bar the scan gate uses: the floor, or within reach of recent cards
    good: Math.max(BLUR_THRESHOLD, Math.max(cam.current?.focusPeak() ?? 0, scanPeak.current) * 0.4),
  }), [scanRoi])

  // Hands-free analysis loop. Base rate ~5 fps waiting, ~6 fps while a card settles; the
  // preview is drawn once per tick (stage.ts) and the Pacer stretches the interval whenever
  // a tick costs more than 15% of wall time or the page itself starts to jank.
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
      const fire = a.step(v, scanRoi(), t)
      setPhase(a.phase)
      const settling = a.phase === 'settling' || a.phase === 'capture'
      if (settling && !wasSettling) { settleStart.current = t; logEvent('settle') }
      wasSettling = settling
      setBlurry(cam.current.focusing())
      if (debug && t - lastDebugTick.current > 500) { lastDebugTick.current = t; liveSharp.current = a.sharpness(); setTick((n) => n + 1) }
      pace.worked(performance.now() - t0, base)
      samplePerf(1000 / Math.max(1, pace.gap), pace.cost, pace.factor)
      if (fire) {
        // Mid-sweep frame: let the sweep finish and look again shortly (never drop the
        // capture: dropping it on an empty jig re-settled forever). Whether the picture is
        // sharp is judged on the full-resolution still: at 720p the preview cannot tell.
        if (cam.current.focusing() && t - settleStart.current < 2500) { a.postpone(t, 200); return }
        void captureRef.current()
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [scanRoi, debug])

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

  const { askFinish, effects, japanese } = useSettings()

  /**
   * Work out the finish. The foil read tells a standard print from a reverse holo
   * (body texture); it cannot tell a holo rare from its reverse (both bodies are foil),
   * so cards without a standard print still ask, with the holo marked likely.
   */
  const decideFinish = (card: CardRecord, rec: Recognition): { finish: Finish; ask: false } | { finish: Finish; ask: true; options: Finish[] } => {
    const options = finishesOf(card)
    if (options.length === 1) return { finish: options[0], ask: false }
    const foil = rec.foil
    const plain = options.filter((f) => f !== 'reverse')
    const standardOrReverse = options.includes('reverse') && plain.length === 1 && plain[0] === 'normal'
    if (standardOrReverse && foil?.confident) return { finish: foil.guess, ask: false }
    // Until the foil read is calibrated its guess is noise: a common is more often a standard
    // print, a rare is more often the holo, so "likely" says that.
    const guess: Finish = standardOrReverse ? 'normal' : options.includes('reverse') && plain.length ? plain[0] : defaultFinish(card)
    return askFinish ? { finish: guess, ask: true, options } : { finish: guess, ask: false }
  }

  const commit = useCallback(async (card: CardRecord, rec: Recognition, finishIn?: Finish) => {
    let finish = finishIn
    if (!finish) {
      const d = decideFinish(card, rec)
      if (d.ask) { pausedRef.current = true; setAsk({ card, rec, options: d.options, guess: d.finish }); return }
      finish = d.finish
    }
    finishByRec.current.set(rec, { finish, answered: !!finishIn, options: finishesOf(card) })
    logEvent('finish', `${finishesOf(card).join('/')} → ${finish}${finishIn ? ' (answered)' : ''} foil=${rec.foil?.ratio.toFixed(2) ?? '-'} rarity=${card.rarity ?? '-'} prices=${Object.keys(card.variantPrices ?? {}).join(',') || '-'} flags=${JSON.stringify(card.variants)}`)
    const ev = await applyScan(card, mode, finish)
    recentSets.current = [card.setId, ...recentSets.current.filter((x) => x !== card.setId)].slice(0, 5)
    setSame(false)
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
    const r: Result = { ev, card, rec }
    lastResult.current = r
    setNote(null)
    setResult(r)
    logEvent('commit', `${card.name} ${card.localId}/${card.setTotal} ${finish}`)
  }, [mode, frameBox, sound, haptics, askFinish, effects])

  const answerFinish = async (finish: Finish) => {
    const a = ask
    setAsk(null)
    pausedRef.current = false
    if (!a) return
    busy.current = true
    try { await commit(a.card, a.rec, finish) } finally { busy.current = false }
  }

  /** "New card" on the tag: the same card again really is another copy. */
  const addAnother = async () => {
    const r = result ?? lastResult.current
    if (!r || busy.current) return
    busy.current = true
    try { await commit(r.card, r.rec, r.ev.finish ?? undefined) } finally { busy.current = false }
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
    const nr = { ...r, ev: { ...r.ev, finish: next, ownedId, valueAud } }
    lastResult.current = nr
    setResult(nr)
  }

  const showNote = (text: string) => {
    setNote(text)
    if (noteTimer.current) clearTimeout(noteTimer.current)
    noteTimer.current = setTimeout(() => setNote(null), 1600)
  }

  /** Full-resolution picture of the wide region (a sensor still when the lens can). */
  const grabWideHere = (wide: Roi, avoid?: HTMLCanvasElement) => grabWide(videoRef.current!, cam.current, wide, avoid)

  /** Find the card inside a wide grab, remember where it is (the frame follows), and crop it out. */
  const locate = (frame: HTMLCanvasElement, wide: Roi, avoid?: HTMLCanvasElement): HTMLCanvasElement => {
    const v = videoRef.current!
    const g = roi()
    const r = locateCard(frame, wide, g, track.current, v, avoid)
    if (r.found) {
      if (r.moved) { track.current = r.roi; analyzer.current.rebaseNext(); layoutFrame() }
      logEvent('card', `found, ${(r.roi.w / g.w * 100).toFixed(0)}% of guide width`)
    } else logEvent('card', 'not found, using ' + (track.current ? 'last position' : 'guide'))
    return r.canvas
  }

  const capture = useCallback(async () => {
    const v = videoRef.current
    if (!v || busy.current) return
    busy.current = true
    const t0 = performance.now()
    let softMiss = false
    let tries = 1
    let still = false
    let rec: Recognition | null = null
    let outcomeWord = ''
    const prefer = new Set(recentSets.current)
    try {
      const wide = wideRoi()
      const grab = await grabWideHere(wide)
      still = grab.still
      let frame = locate(grab.canvas, wide)
      lastFrame.current = frame
      const ja = useSettings.getState().japanese
      rec = await recognize(frame, { debug, prefer, ja })
      // A soft still (lens still hunting, stack height changed): one focus pass and one retake.
      if (!rec.empty && rec.sharpness > 0 && rec.sharpness < BLUR_THRESHOLD && cam.current) {
        setBlurry(true)
        const tr = performance.now(); lastRefocus.current = tr
        await cam.current.refocus(focusOpts())
        logEvent('refocus', `still soft ${rec.sharpness.toFixed(2)}`, performance.now() - tr)
        setBlurry(false)
        tries++
        const g = await grabWideHere(wide, grab.canvas)
        const retaken = locate(g.canvas, wide, frame)
        const again = await recognize(retaken, { debug, prefer, ja })
        if (again.sharpness > rec.sharpness) { rec = again; frame = retaken; lastFrame.current = frame }
      }
      // Foil and glare change frame to frame: before giving up, read up to two more
      // frames, pooling their OCR text with what has been read so far. A frame with a
      // card in it that read as nothing (foil over the number, patterned reverse) is
      // retried too; only an empty frame or a soft one is not.
      for (let attempt = 0; attempt < 2 && !rec.card && !rec.empty && rec.sharpness >= BLUR_THRESHOLD; attempt++) {
        await new Promise((r) => setTimeout(r, 200))
        tries++
        const g = await grabWideHere(wide)
        const again = await recognize(locate(g.canvas, wide), { debug, prior: rec, prefer, ja })
        rec = again.empty ? rec : again
      }
      const a = analyzer.current
      if (rec.card) {
        prefetchCardImage(rec.card.image, 'low')
        const last = lastCommit.current
        // The same card as the last scan is taken to be the same copy still sitting there
        // (a hand passed over, the light changed, it sat for a while). "New card" on the
        // tag adds another copy when a stack really has two in a row.
        if (last && last.id === rec.card.id) {
          outcomeWord = 'same'
          showNote('Same card')
          setResult((r) => r ?? lastResult.current)
          setSame(true)
        } else {
          outcomeWord = 'commit'
          await commit(rec.card, rec)
        }
      } else if (rec.sharpness > 0 && rec.sharpness < BLUR_THRESHOLD) {
        outcomeWord = 'soft'
        softMiss = true                                  // the lens was still moving: try this card again
      } else if (rec.empty) {
        outcomeWord = 'no card'
        setResult(null); setSame(false)                  // the card is gone
        showNote(a.scans <= 1 ? 'Ready' : 'No card')   // empty jig, table
      } else if (isBlank(rec)) {
        outcomeWord = "can't read"
        setResult(null); setSame(false)
        feedback('fail', 60)
        showNote("Can't read")                           // something is there, but no number or name came out
      } else {
        outcomeWord = 'not sure'
        setResult(null)
        feedback('fail', 60)
        pausedRef.current = true
        setMiss(rec)
      }
    } catch (e: any) {
      outcomeWord = `error ${e?.message ?? e}`
      toast(e?.message ?? 'Scan failed')
    } finally {
      const ms = performance.now() - t0
      lastCapture.current = { ms, ocrMs: rec?.ocrMs ?? 0, tries, still }
      logScan({ ms, ocrMs: rec?.ocrMs ?? 0, tries, outcome: outcomeWord + (still ? '' : ' (preview frame)'), card: rec?.card ? `${rec.card.name} ${rec.card.localId}/${rec.card.setTotal}` : undefined, conf: rec?.confidence, num: rec?.parsed.number ? `${rec.parsed.number}/${rec.parsed.total ?? '?'}` : undefined, name: rec?.parsed.nameGuess || undefined, foil: rec?.foil?.ratio, sharp: rec?.sharpness })
      const lf = lastFrame.current
      if (rec && !rec.empty && lf && lf.width) {
        try {
          const sc = Math.min(1, 640 / lf.height)
          const c = document.createElement('canvas'); c.width = Math.round(lf.width * sc); c.height = Math.round(lf.height * sc)
          c.getContext('2d')!.drawImage(lf, 0, 0, c.width, c.height)
          crops.current = [...crops.current.slice(-11), { i: cropSeq.current++, at: Date.now(), jpeg: c.toDataURL('image/jpeg', 0.55), rec, card: rec.card ? `${rec.card.name} ${rec.card.localId}/${rec.card.setTotal} (${rec.card.id})` : undefined, outcome: outcomeWord, foil: rec.foil, sharp: rec.sharpness }]
        } catch { /* a crop is a nicety */ }
      }
      if (softMiss) analyzer.current.retry()
      else analyzer.current.release()
      busy.current = false
      void recycleOcrIfNeeded()
    }
  }, [scanRoi, wideRoi, commit, debug, focusOpts])

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
    track.current = null; layoutFrame()
    logEvent('start')
    try { await cam.current.refocus({ ...focusOpts(), full: true }) } catch { /* ignore */ }
    setBlurry(false); setStarting(false)
    analyzer.current.reset()
    runningRef.current = true; setRunning(true)
  }
  const stop = () => {
    runningRef.current = false; setRunning(false)
    setBlurry(false); setNote(null); setResult(null); setSame(false)
    logEvent('stop')
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

  const preview4k = useSettings((s) => s.preview4k)
  const toggleRes = () => {
    setSettings({ preview4k: !preview4k })
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
    const card = await getCard(id, { quick: true })
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
  const camSettings = cam.current?.settings() ?? {}

  // ---- Diagnostic report: the perf log plus the last read's strips and the live frame ----
  const shrink = (src: string | null | undefined, maxW = 900): Promise<string | null> => new Promise((res) => {
    if (!src) return res(null)
    const i = new Image()
    i.onload = () => {
      const s = Math.min(1, maxW / i.width)
      const c = document.createElement('canvas'); c.width = Math.round(i.width * s); c.height = Math.round(i.height * s)
      c.getContext('2d')!.drawImage(i, 0, 0, c.width, c.height)
      res(c.toDataURL('image/jpeg', 0.6))
    }
    i.onerror = () => res(null)
    i.src = src
  })
  const makeReport = async () => {
    const v = videoRef.current
    const rec = lastRec
    let frame: string | null = null
    if (v && v.videoWidth) {
      const w = wideRoi()
      const c = document.createElement('canvas')
      const s = 600 / (w.w * v.videoWidth)
      c.width = 600; c.height = Math.round(w.h * v.videoHeight * s)
      c.getContext('2d')!.drawImage(v, w.x * v.videoWidth, w.y * v.videoHeight, w.w * v.videoWidth, w.h * v.videoHeight, 0, 0, c.width, c.height)
      frame = c.toDataURL('image/jpeg', 0.6)
    }
    let cardCrop: string | null = null
    const lf = lastFrame.current
    if (lf && lf.width) {
      const sc = Math.min(1, 800 / lf.height)
      const c = document.createElement('canvas'); c.width = Math.round(lf.width * sc); c.height = Math.round(lf.height * sc)
      c.getContext('2d')!.drawImage(lf, 0, 0, c.width, c.height)
      cardCrop = c.toDataURL('image/jpeg', 0.7)
    }
    const bands = rec?.bands ? { top: await shrink(rec.bands.top), bottom: await shrink(rec.bands.bottom), corner: await shrink(rec.bands.corner) } : null
    const id = Math.random().toString(36).slice(2, 8)
    const text = {
      ...baseReport(BUILD), id, source: 'scan',
      camera: { ...camInfo, video: `${v?.videoWidth ?? 0}x${v?.videoHeight ?? 0}`, settings: camSettings, focusModes: cam.current?.focusModes },
      settings: { preview4k, effects, askFinish, mode, debug },
      pacer: { fps: Math.round(1000 / Math.max(1, pacer.current.gap)), tick: pacer.current.cost, factor: pacer.current.factor },
      analyzer: { phase, motion: analyzer.current.motion, change: analyzer.current.change, scans: analyzer.current.scans, sharp: liveSharp.current, peak: Math.max(cam.current?.focusPeak() ?? 0, scanPeak.current), track: track.current, guide: roi(), ocrJobs: ocrJobs() },
      lastCapture: lastCapture.current,
      lastRead: rec ? {
        card: rec.card ? `${rec.card.name} ${rec.card.localId}/${rec.card.setTotal} (${rec.card.id})` : null,
        confidence: rec.confidence, ms: rec.ms, ocrMs: rec.ocrMs, sharpness: rec.sharpness, foil: rec.foil, empty: rec.empty,
        ocr: rec.ocr, parsed: rec.parsed,
        alternatives: (rec.alternatives ?? []).slice(0, 6).map((a) => `${a.entry.name} ${a.entry.n}/${a.entry.total} (${a.entry.set}) ${a.score.toFixed(2)}`),
      } : null,
    }
    const cropMeta = crops.current.map((c) => {
      const f = finishByRec.current.get(c.rec)
      return { i: c.i, at: new Date(c.at).toISOString(), card: c.card, outcome: c.outcome, foil: c.foil, sharp: c.sharp, finish: f?.finish, answered: f?.answered, options: f?.options }
    })
    return { id, text: { ...text, crops: cropMeta, cropCount: crops.current.length }, images: { frame, cardCrop, bands }, cropImages: crops.current.map((c) => ({ i: c.i, jpeg: c.jpeg })) }
  }
  const sendReport = async () => {
    try {
      if (!companionConnected()) { toast('Desk not linked: sharing the file instead'); return shareReport() }
      const r = await makeReport()
      const ok1 = await sendCompanion({ type: 'report', report: r.text })
      const ok2 = await sendCompanion({ type: 'report-images', report: { id: r.id, ...r.images } })
      let sent = 0
      // The live link drops bursts: one crop every 200 ms
      for (const c of r.cropImages) { if (await sendCompanion({ type: 'report-crop', report: { id: r.id, i: c.i, jpeg: c.jpeg } })) sent++; await new Promise((res) => setTimeout(res, 200)) }
      toast(ok1 ? (ok2 ? `Report sent to Desk (${sent} card crops)` : 'Report sent (images too big for the link)') : 'Could not reach the Desk')
    } catch (e: any) { toast(e?.message ?? 'Report failed') }
  }
  const shareReport = async () => {
    try {
      const r = await makeReport()
      const file = new File([JSON.stringify({ ...r.text, ...r.images, cropImages: r.cropImages })], `bind-report-${r.id}.json`, { type: 'application/json' })
      const n = navigator as any
      if (n.share && (!n.canShare || n.canShare({ files: [file] }))) { try { await n.share({ files: [file], title: 'Bind report' }) } catch { /* cancelled */ } }
      else { const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; a.click() }
    } catch (e: any) { toast(e?.message ?? 'Report failed') }
  }

  // The scanned card is "present" while the analyzer sees the frame it scanned; it goes
  // stale the moment something moves (card being pulled, the next one settling).
  const stale = phase === 'settling' || phase === 'capture'
  const found = result && !stale
  const out = result ? outcome(result.ev) : null
  const statusWord = ask ? 'Finish?' : miss ? 'Not sure' : blurry ? 'Focus' : !running ? 'Paused' : phase === 'capture' || busy.current ? 'Reading' : phase === 'settling' ? 'Hold' : found ? 'Scanned' : 'Ready'
  const dotClass = !running && !blurry ? '' : phase === 'settling' || blurry ? 'scan__dot--hold' : phase === 'capture' || busy.current ? 'scan__dot--busy' : 'scan__dot--on'
  const heapMb = (performance as any).memory?.usedJSHeapSize ? ((performance as any).memory.usedJSHeapSize / 1048576).toFixed(0) : '-'
  const tagTop = frameBox ? Math.min(frameBox.top + frameBox.height + 10, window.innerHeight - 118 - 100) : 0
  const askOptions = ask ? [...ask.options].sort((a, b) => (a === ask.guess ? -1 : 0) - (b === ask.guess ? -1 : 0)) : []

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
          style={{ ...frameBox, ...(found && out ? { borderColor: out.color } : {}), transition: 'left 0.25s, top 0.25s, width 0.25s, height 0.25s, border-color 0.2s' }}
        >
          <i className="scan__corner tl" /><i className="scan__corner tr" /><i className="scan__corner bl" /><i className="scan__corner br" />
          {/* Big badge on the card itself: which pile it goes on */}
          {found && out && (
            <div className="scan__badge" style={{ background: out.color, color: out.ink }}>
              <Check size={22} strokeWidth={3.5} /> {note ?? out.word}
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
            {same && (
              <div className="scan__same">
                <span><Check size={16} strokeWidth={3} /> Same card, still here</span>
                <button className="scan__tagnew" onClick={() => void addAnother()} aria-label="Add another copy of this card"><Plus size={14} strokeWidth={3} /> New card</button>
              </div>
            )}
            <div className="scan__tagmain">
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
                {result.card.lang === 'ja' && <span className="chip chip--unknown" style={{ height: 26, fontSize: 'var(--fs-xs)' }} title={result.card.nameJa ?? ''}>JP</span>}
                <span className={`scan__tagvalue ${result.ev.highValue ? 'scan__tagvalue--hot' : ''}`}>{fmtAud(result.ev.valueAud)}</span>
              </div>
            </div>
            <button className="scan__tagview" onClick={openView} aria-label="View card"><Eye size={20} /></button>
            </div>
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
              <button className={`scan__tunebtn ${preview4k ? 'on' : ''}`} onClick={toggleRes} aria-label="Preview resolution"><Focus size={20} /><span>{preview4k ? '4K' : '720p'}</span></button>
              <button className={`scan__tunebtn ${effects ? '' : 'on'}`} onClick={() => setSettings({ effects: !effects })} aria-label="Effects"><Sparkles size={20} /><span>{effects ? 'FX on' : 'Lite'}</span></button>
              <button className={`scan__tunebtn ${japanese ? 'on' : ''}`} onClick={() => setSettings({ japanese: !japanese })} aria-label="Expect Japanese cards"><Languages size={20} /><span>JP</span></button>
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
        <div className="scan__ocr" style={{ top: 'calc(var(--safe-t) + 64px)', maxHeight: '46vh', overflow: 'hidden' }}>
          <div className="row" style={{ gap: 6, marginBottom: 6 }}>
            <button className="btn btn--sm btn--accent" onClick={() => void sendReport()}><Send size={14} /> Send to Desk</button>
            <button className="btn btn--sm" onClick={() => void shareReport()}><Share2 size={14} /> Share</button>
          </div>
          {`${videoRef.current?.videoWidth ?? 0}x${videoRef.current?.videoHeight ?? 0} still=${camInfo?.still ? 'yes' : 'no'} focus=${camSettings.focusMode ?? '-'}${camSettings.focusDistance != null ? `@${camSettings.focusDistance}` : ''} zoom=${camSettings.zoom ?? '-'} modes=${cam.current?.focusModes.join(',') || '-'} cam="${camInfo?.label ?? ''}"\n`}
          {`page ${(1000 / Math.max(1, pacer.current.gap)).toFixed(0)}fps tick=${pacer.current.cost.toFixed(1)}ms x${pacer.current.factor.toFixed(2)} heap=${heapMb}MB ocrJobs=${ocrJobs()} last=${lastCapture.current ? `${lastCapture.current.ms.toFixed(0)}ms (ocr ${lastCapture.current.ocrMs.toFixed(0)}ms, ${lastCapture.current.tries} read${lastCapture.current.tries > 1 ? 's' : ''}${lastCapture.current.still ? ', still' : ', preview'})` : '-'}\n`}
          {`phase=${phase} motion=${analyzer.current.motion.toFixed(3)} change=${analyzer.current.change.toFixed(3)} sharp=${liveSharp.current.toFixed(3)} (min ${BLUR_THRESHOLD}, peak ${Math.max(cam.current?.focusPeak() ?? 0, scanPeak.current).toFixed(3)}) scans=${analyzer.current.scans} card=${track.current ? `${(track.current.w / roi().w * 100).toFixed(0)}%` : 'guide'}\n`}
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

      {/* Which finish? Stays until answered; scanning waits. Likely one on top. */}
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
              {askOptions.map((f) => (
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
            <button className="btn btn--block" onClick={() => void sendReport()}><Send size={18} /> Send report to Desk</button>
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
    Promise.all([setNameOf(entry.set), getCard(entry.id, { quick: true }).catch(() => null)]).then(([set, card]) => {
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
              <div className="list__sub">{setCode(e.set).toUpperCase()} · {e.n}/{e.total}</div>
            </button>
          ))}
        </div>
      </div>
    </Sheet>
  )
}
