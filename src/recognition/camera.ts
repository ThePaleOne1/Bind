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
  /** Kick the autofocus. Resolves once the request has been applied. */
  refocus: () => Promise<void>
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

export async function startCamera(video: HTMLVideoElement, opts: { deviceId?: string | null } = {}): Promise<CameraHandle> {
  const base: MediaTrackConstraints = {
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    frameRate: { ideal: 30 },
    // Advanced constraints are ignored by browsers that do not support them.
    advanced: [{ focusMode: 'continuous' } as any],
  }
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: opts.deviceId ? { ...base, deviceId: { exact: opts.deviceId } } : { ...base, facingMode: { ideal: 'environment' } },
    })
  } catch (e) {
    if (!opts.deviceId) throw e
    // the remembered camera is gone: fall back to any rear camera
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...base, facingMode: { ideal: 'environment' } } })
  }
  video.srcObject = stream
  video.setAttribute('playsinline', 'true')
  video.muted = true
  await video.play()
  const track = stream.getVideoTracks()[0]
  const caps: any = track.getCapabilities?.() ?? {}
  const deviceId: string | null = track.getSettings?.().deviceId ?? opts.deviceId ?? null
  const devices = await listBackCameras(deviceId)

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

  let manual = false
  const refocus = async () => {
    if (manual) return
    if (focusModes.includes('single-shot')) {
      // A single-shot request forces one autofocus sweep; then go back to tracking.
      await apply({ focusMode: 'single-shot' })
      if (focusModes.includes('continuous')) setTimeout(() => void apply({ focusMode: 'continuous' }), 900)
    } else if (focusModes.includes('continuous')) {
      // Re-asserting the mode nudges some drivers into a fresh sweep.
      if (focusModes.includes('manual')) await apply({ focusMode: 'manual' })
      await apply({ focusMode: 'continuous' })
    }
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
    setFocusDistance: async (d) => {
      if (d == null) {
        manual = false
        return apply({ focusMode: focusModes.includes('continuous') ? 'continuous' : 'single-shot' })
      }
      if (!focusRange) return false
      manual = true
      return apply({ focusMode: 'manual', focusDistance: Math.max(focusRange.min, Math.min(focusRange.max, d)) })
    },
    setZoom: async (z) => {
      if (!zoomRange) return false
      return apply({ zoom: Math.max(zoomRange.min, Math.min(zoomRange.max, z)) })
    },
    settings: () => (track.getSettings?.() ?? {}) as any,
    stop: () => stream.getTracks().forEach((t) => t.stop()),
  }
}
