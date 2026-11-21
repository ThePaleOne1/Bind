export interface CameraHandle {
  stream: MediaStream
  track: MediaStreamTrack
  hasTorch: boolean
  torch: (on: boolean) => Promise<boolean>
  /** Exposure compensation range in EV, or null when the device does not expose it. */
  exposureRange: { min: number; max: number; step: number } | null
  setExposure: (ev: number) => Promise<boolean>
  stop: () => void
}

export async function startCamera(video: HTMLVideoElement): Promise<CameraHandle> {
  const constraints: MediaStreamConstraints = {
    audio: false,
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30 },
    },
  }
  const stream = await navigator.mediaDevices.getUserMedia(constraints)
  video.srcObject = stream
  video.setAttribute('playsinline', 'true')
  video.muted = true
  await video.play()
  const track = stream.getVideoTracks()[0]
  const caps: any = track.getCapabilities?.() ?? {}
  const hasTorch = !!caps.torch
  const exposureRange = caps.exposureCompensation
    ? { min: caps.exposureCompensation.min, max: caps.exposureCompensation.max, step: caps.exposureCompensation.step || 0.5 }
    : null

  // Continuous focus + exposure so the card is sharp and not blown out when held still.
  const advanced: any[] = []
  if (caps.focusMode?.includes('continuous')) advanced.push({ focusMode: 'continuous' })
  if (caps.exposureMode?.includes('continuous')) advanced.push({ exposureMode: 'continuous' })
  if (caps.whiteBalanceMode?.includes('continuous')) advanced.push({ whiteBalanceMode: 'continuous' })
  if (advanced.length) { try { await track.applyConstraints({ advanced }) } catch { /* ignore */ } }

  return {
    stream,
    track,
    hasTorch,
    exposureRange,
    torch: async (on) => {
      try { await track.applyConstraints({ advanced: [{ torch: on } as any] }); return on } catch { return false }
    },
    setExposure: async (ev) => {
      if (!exposureRange) return false
      const clamped = Math.max(exposureRange.min, Math.min(exposureRange.max, ev))
      try { await track.applyConstraints({ advanced: [{ exposureCompensation: clamped } as any] }); return true } catch { return false }
    },
    stop: () => stream.getTracks().forEach((t) => t.stop()),
  }
}
