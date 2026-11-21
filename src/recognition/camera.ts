export interface Range { min: number; max: number; step: number }

export interface CameraDevice { id: string; label: string }

export interface CameraHandle {
  stream: MediaStream
  track: MediaStreamTrack
  deviceId: string | null
  /** Rear-facing cameras available on this device (for switching lenses). */
  devices: CameraDevice[]
  hasTorch: boolean
  torch: (on: boolean) => Promise<boolean>
  /** Exposure compensation range in EV, or null when the device does not expose it. */
  exposureRange: Range | null
  setExposure: (ev: number) => Promise<boolean>
  /** Focus modes the camera reports ('continuous', 'single-shot', 'manual', 'none'). */
  focusModes: string[]
  /** Manual focus distance range (device units), when supported. */
  focusRange: Range | null
  /**
   * Get the card sharp. Uses the autofocus when the lens has one; on a lens that
   * only takes a focus distance (common on Android), sweeps the distance and
   * locks the sharpest, judged by `measure` (higher = sharper, `good` = sharp enough).
   */
  refocus: (opts?: { measure: () => number; good: number; full?: boolean }) => Promise<boolean>
  /** True while a focus sweep is running. */
  focusing: () => boolean
  /** Best sharpness a sweep has reached on this lens (0 when none has run). */
  focusPeak: () => number
  /** Manual focus distance; null returns to automatic. */
  setFocusDistance: (d: number | null) => Promise<boolean>
  zoomRange: Range | null
  setZoom: (z: number) => Promise<boolean>
  /** Live track settings (actual resolution, focus mode, zoom, …). */
  settings: () => MediaTrackSettings & Record<string, any>
  stop: () => void
}

const toRange = (r: any, fallbackStep = 1): Range | null =>
  r && typeof r.min === 'number' && typeof r.max === 'number' && r.max > r.min
    ? { min: r.min, max: r.max, step: r.step || fallbackStep }
    : null

const BACK_RE = /back|rear|environment/i
const FRONT_RE = /front|user|face|selfie/i
// Android lists lenses as "camera2 0, facing back", "camera2 2, facing back", …; 0 is the
// main lens with autofocus, the others are usually ultrawide/macro with fixed focus.
const MAIN_RE = /camera2?\s*0\b|\bback camera$|\bmain\b|\bwide(?!.*ultra)/i

/** Which rear camera to open when the user has not chosen one. */
export function preferredDevice(devices: CameraDevice[]): CameraDevice | null {
  return devices.find((d) => MAIN_RE.test(d.label)) ?? devices[0] ?? null
}

async function listBackCameras(currentId: string | null): Promise<CameraDevice[]> {
  try {
    const all = await navigator.mediaDevices.enumerateDevices()
    const cams = all.filter((d) => d.kind === 'videoinput')
    const labelled = cams.some((d) => d.label)
    const back = cams.filter((d) => !labelled || BACK_RE.test(d.label) || (!FRONT_RE.test(d.label) && d.deviceId === currentId))
    const list = (back.length ? back : cams).map((d, i) => ({ id: d.deviceId, label: d.label || `Camera ${i + 1}` }))
    if (currentId && !list.some((d) => d.id === currentId)) {
      const cur = cams.find((d) => d.deviceId === currentId)
      if (cur) list.unshift({ id: cur.deviceId, label: cur.label || 'Camera' })
    }
    return list
  } catch {
    return []
  }
}

export async function startCamera(video: HTMLVideoElement, opts: { deviceId?: string | null; hiRes?: boolean; _retry?: boolean } = {}): Promise<CameraHandle> {
  const base: MediaTrackConstraints = {
    // 4K by default: the collector number is ~9 px tall at 1080p and foil patterns eat it.
    // Analysis and OCR costs do not grow (GPU downscale, bands resampled to fixed heights),
    // but the preview itself is heavier, so it can be turned down.
    width: { ideal: opts.hiRes === false ? 1920 : 3840 },
    height: { ideal: opts.hiRes === false ? 1080 : 2160 },
    frameRate: { ideal: 30 },
    // Advanced constraints are ignored by browsers that do not support them.
    advanced: [{ focusMode: 'continuous' } as any],
  }
  // Once permission has been granted, lens labels are available before opening the
  // camera, so the main lens can be chosen up front instead of whatever "environment" gives.
  let wanted = opts.deviceId || null
  if (!wanted) {
    const known = await listBackCameras(null)
    if (known.some((d) => /facing|camera/i.test(d.label))) wanted = preferredDevice(known)?.id ?? null
  }
  const open = (v: MediaTrackConstraints) => navigator.mediaDevices.getUserMedia({ audio: false, video: v })
  let stream: MediaStream
  try {
    stream = await open(wanted ? { ...base, deviceId: { exact: wanted } } : { ...base, facingMode: { ideal: 'environment' } })
  } catch (e) {
    if (!wanted) throw e
    // Some phones refuse a lens that was released a moment ago: one more try, then any rear camera.
    await new Promise((r) => setTimeout(r, 500))
    try {
      stream = await open({ ...base, deviceId: { exact: wanted } })
    } catch {
      stream = await open({ ...base, facingMode: { ideal: 'environment' } })
    }
  }
  video.srcObject = stream
  video.setAttribute('playsinline', 'true')
  video.muted = true
  await video.play()
  const track = stream.getVideoTracks()[0]
  const caps: any = track.getCapabilities?.() ?? {}
  const deviceId: string | null = track.getSettings?.().deviceId ?? wanted ?? null
  const devices = await listBackCameras(deviceId)

  // First run (labels were unknown until now): if the browser opened a secondary lens,
  // reopen on the main one.
  if (!opts.deviceId && !opts._retry && devices.length > 1) {
    const pref = preferredDevice(devices)
    if (pref && pref.id !== deviceId) {
      stream.getTracks().forEach((t) => t.stop())
      await new Promise((r) => setTimeout(r, 350))   // let the driver release the lens first
      return startCamera(video, { deviceId: pref.id, hiRes: opts.hiRes, _retry: true })
    }
  }

  const hasTorch = !!caps.torch
  const exposureRange = toRange(caps.exposureCompensation, 0.5)
  const focusModes: string[] = Array.isArray(caps.focusMode) ? caps.focusMode : []
  const focusRange = focusModes.includes('manual') ? toRange(caps.focusDistance, 0.01) : null
  const zoomRange = toRange(caps.zoom, 0.1)

  const apply = async (c: Record<string, any>) => {
    try { await track.applyConstraints({ advanced: [c as any] }); return true } catch { return false }
  }

  // Continuous focus + exposure so the card is sharp and not blown out when held still.
  const advanced: any[] = []
  if (focusModes.includes('continuous')) advanced.push({ focusMode: 'continuous' })
  if (caps.exposureMode?.includes('continuous')) advanced.push({ exposureMode: 'continuous' })
  if (caps.whiteBalanceMode?.includes('continuous')) advanced.push({ whiteBalanceMode: 'continuous' })
  if (advanced.length) { try { await track.applyConstraints({ advanced }) } catch { /* ignore */ } }

  let manual = false          // the user (or a sweep) has locked a focus distance
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const hasAf = focusModes.includes('single-shot') || focusModes.includes('continuous')

  let locked: number | null = null   // distance a sweep settled on
  let peak = 0                       // sharpness reached at that lock
  const clampD = (d: number) => Math.max(focusRange!.min, Math.min(focusRange!.max, d))
  const sample = async (d: number, measure: () => number) => {
    await apply({ focusMode: 'manual', focusDistance: d })
    await sleep(260)
    // median of three readings: a single frame can land mid-transition or on a noisy frame
    const r = [measure()]; await sleep(70); r.push(measure()); await sleep(70); r.push(measure())
    return r.sort((x, y) => x - y)[1]
  }

  /** Full search: step through the whole distance range, then refine, and lock the sharpest. */
  const sweep = async (measure: () => number) => {
    if (!focusRange) return
    const { min, max } = focusRange
    const n = 9
    const pts: number[] = []
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1)
      pts.push(min > 0 && max / min > 20 ? min * Math.pow(max / min, t) : min + (max - min) * t)
    }
    let best = { d: pts[0], s: -1 }
    for (const d of pts) {
      const sc = await sample(d, measure)
      if (sc > best.s) best = { d, s: sc }
    }
    // Refine: halve the step around the best point until it is fine enough.
    let step = (pts[1] - pts[0]) / 2
    const fine = Math.max(focusRange.step, (max - min) / 400)
    for (let level = 0; level < 5 && step >= fine; level++, step /= 2) {
      for (const d of [clampD(best.d - step), clampD(best.d + step)]) {
        if (d === best.d) continue
        const sc = await sample(d, measure)
        if (sc > best.s) best = { d, s: sc }
      }
    }
    await apply({ focusMode: 'manual', focusDistance: best.d })
    locked = best.d
    peak = Math.max(peak, best.s)
    manual = true
  }

  /**
   * Local search around the locked distance. As a stack of cards gets shorter the
   * card drifts a centimetre or two further away, which only needs a nudge, not a
   * full sweep. Returns true when the result is sharp enough.
   */
  const nudge = async (measure: () => number, good: number) => {
    if (!focusRange || locked == null) return false
    const span = Math.max(focusRange.step * 2, (focusRange.max - focusRange.min) * 0.03, Math.abs(locked) * 0.08)
    let best = { d: locked, s: await sample(locked, measure) }
    for (let k = 1; k <= 3; k++) {
      let improved = false
      for (const d of [clampD(locked - k * span), clampD(locked + k * span)]) {
        if (d === best.d) continue
        const sc = await sample(d, measure)
        if (sc > best.s) { best = { d, s: sc }; improved = true }
      }
      if (!improved && best.s >= good) break
    }
    await apply({ focusMode: 'manual', focusDistance: best.d })
    locked = best.d
    peak = Math.max(peak, best.s)
    manual = true
    return best.s >= good
  }

  let sweeping: Promise<boolean> | null = null
  const refocus = async (o?: { measure: () => number; good: number; full?: boolean }) => {
    if (sweeping) return sweeping
    if (o?.full) { locked = null; peak = 0 }   // calibrate from scratch
    const run = async (): Promise<boolean> => {
      if (hasAf && !manual) {
        if (focusModes.includes('single-shot')) {
          // A single-shot request forces one autofocus pass; then go back to tracking.
          await apply({ focusMode: 'single-shot' })
          if (focusModes.includes('continuous')) setTimeout(() => void apply({ focusMode: 'continuous' }), 900)
        } else {
          // Re-asserting the mode nudges some drivers into a fresh pass.
          if (focusModes.includes('manual')) await apply({ focusMode: 'manual' })
          await apply({ focusMode: 'continuous' })
        }
        if (!o) return true
        // Every kick restarts the hunt, so do not stack them: wait here until the lens has
        // landed (sharp enough and two readings agreeing), up to 1.6 s.
        let prev = -1
        const until = performance.now() + 1600
        while (performance.now() < until) {
          await sleep(150)
          const m = o.measure()
          if (m >= o.good && prev >= 0 && Math.abs(m - prev) <= 0.15 * Math.max(m, prev, 1e-3)) return true
          prev = m
        }
        if (o.measure() >= o.good || !focusRange) return true
      }
      if (!o || !focusRange) return false
      // Distance-only lens (or the autofocus could not lock): a nudge around the last
      // lock first, a full sweep when that is not enough.
      if (locked != null && (await nudge(o.measure, o.good))) return true
      await sweep(o.measure)
      return true
    }
    sweeping = run().finally(() => { sweeping = null })
    return sweeping
  }

  return {
    stream,
    track,
    deviceId,
    devices,
    hasTorch,
    exposureRange,
    focusModes,
    focusRange,
    zoomRange,
    torch: async (on) => (await apply({ torch: on })) ? on : false,
    setExposure: async (ev) => {
      if (!exposureRange) return false
      return apply({ exposureCompensation: Math.max(exposureRange.min, Math.min(exposureRange.max, ev)) })
    },
    refocus,
    focusing: () => sweeping != null,
    focusPeak: () => peak,
    setFocusDistance: async (d) => {
      if (d == null) {
        manual = false
        locked = null
        if (!hasAf) return false
        return apply({ focusMode: focusModes.includes('continuous') ? 'continuous' : 'single-shot' })
      }
      if (!focusRange) return false
      manual = true
      locked = clampD(d)
      return apply({ focusMode: 'manual', focusDistance: locked })
    },
    setZoom: async (z) => {
      if (!zoomRange) return false
      return apply({ zoom: Math.max(zoomRange.min, Math.min(zoomRange.max, z)) })
    },
    settings: () => (track.getSettings?.() ?? {}) as any,
    stop: () => stream.getTracks().forEach((t) => t.stop()),
  }
}
