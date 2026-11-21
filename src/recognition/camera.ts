export interface CameraHandle {
  stream: MediaStream
  track: MediaStreamTrack
  torch: (on: boolean) => Promise<boolean>
  hasTorch: boolean
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
  // Prefer continuous focus so the card is sharp when held still
  try {
    if (caps.focusMode?.includes('continuous')) {
      await track.applyConstraints({ advanced: [{ focusMode: 'continuous' } as any] })
    }
  } catch { /* ignore */ }
  return {
    stream,
    track,
    hasTorch,
    torch: async (on) => {
      try { await track.applyConstraints({ advanced: [{ torch: on } as any] }); return on } catch { return false }
    },
    stop: () => stream.getTracks().forEach((t) => t.stop()),
  }
}
