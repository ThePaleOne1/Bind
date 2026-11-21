/**
 * Watches the guide region of the camera feed and decides, hands-free, when to
 * scan. Built for a stationary phone looking at a stack of cards: pulling the
 * top card away reveals the next one, so a scan is triggered by
 *
 *   a disturbance (hand / card moving through the frame)
 *   followed by the frame going still for HOLD_MS.
 *
 * Nothing depends on an "empty" background, so a stack that is already in frame
 * when the camera starts is scanned straight away, a card can be swapped for an
 * identical duplicate, and an empty jig after the last card simply produces a
 * scan that finds nothing (the screen ignores it quietly).
 *
 *   IDLE ──(motion burst)──▶ SETTLING ──(still for HOLD_MS)──▶ CAPTURE ──▶ BUSY ──release()──▶ IDLE
 *
 * A gentle placement with no motion burst is caught as well: a still frame that
 * differs a lot from the last scanned frame also moves IDLE → SETTLING.
 */
export type Phase = 'idle' | 'settling' | 'capture' | 'busy'

export interface Roi { x: number; y: number; w: number; h: number } // fractions of the video frame

const W = 48
const H = 64
const HOLD_MS = 350
const MOTION_MAX = 0.025        // frame-to-frame change considered "still"
const DISTURB = 0.035          // frame-to-frame change considered "something moved"
const DISTURB_FRAMES = 2
const CHANGE_SLOW = 0.12        // still frame differing this much from the last scan → new card placed gently

export class FrameAnalyzer {
  // Two canvases on purpose. Drawing a live camera frame into a canvas that is
  // marked for pixel reads makes the browser copy the whole 1080x1920 frame out
  // of the GPU and colour-convert it on the CPU, twelve times a second. Instead
  // the GPU-backed canvas does the downscale, and only the 48x64 result is read.
  private gpu = document.createElement('canvas')
  private gctx = this.gpu.getContext('2d')!
  private canvas = document.createElement('canvas')
  private ctx = this.canvas.getContext('2d', { willReadFrequently: true })!
  private prev: Float32Array | null = null
  private reference: Float32Array | null = null  // the frame last scanned
  private captured: Float32Array | null = null
  private settleSince = 0
  private disturbFrames = 0
  private disturbedWhileBusy = false
  phase: Phase = 'settling'   // scan whatever is in frame once the picture is stable
  motion = 0
  /** How much the frame just captured differs from the previous scan (0 = identical). */
  change = 1
  scans = 0

  constructor() {
    this.canvas.width = W
    this.canvas.height = H
    this.gpu.width = W
    this.gpu.height = H
    this.settleSince = performance.now()
  }

  /** The read failed for a reason that may clear (soft focus): keep the old reference and settle again. */
  retry() {
    if (this.phase !== 'capture' && this.phase !== 'busy') return
    this.captured = null
    this.disturbFrames = 0
    this.disturbedWhileBusy = false
    this.phase = 'settling'
    this.settleSince = performance.now()
  }

  /** Not ready yet (autofocus still moving): fire again in `ms`. */
  postpone(now: number, ms = 200) {
    if (this.phase !== 'capture') return
    this.phase = 'settling'
    this.settleSince = now - HOLD_MS + ms
    this.captured = null
    this.scans--
  }

  reset() {
    this.prev = null
    this.reference = null
    this.captured = null
    this.disturbFrames = 0
    this.disturbedWhileBusy = false
    this.phase = 'settling'
    this.settleSince = performance.now()
  }

  /** Call when the recognition pipeline is done with the current card. */
  release() {
    if (this.phase !== 'capture' && this.phase !== 'busy') return
    this.reference = this.captured ?? this.reference
    this.captured = null
    this.disturbFrames = 0
    if (this.disturbedWhileBusy) {
      // the next card was already pulled while we were reading: go straight to settling
      this.disturbedWhileBusy = false
      this.phase = 'settling'
      this.settleSince = performance.now()
    } else {
      this.phase = 'idle'
    }
  }

  private gray(video: HTMLVideoElement, roi: Roi): Float32Array {
    const vw = video.videoWidth, vh = video.videoHeight
    this.gctx.drawImage(video, roi.x * vw, roi.y * vh, roi.w * vw, roi.h * vh, 0, 0, W, H)
    this.ctx.drawImage(this.gpu, 0, 0)
    const d = this.ctx.getImageData(0, 0, W, H).data
    const g = new Float32Array(W * H)
    for (let i = 0, j = 0; i < d.length; i += 4, j++) g[j] = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 255
    return g
  }

  private diff(a: Float32Array, b: Float32Array) {
    let s = 0
    for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i])
    return s / a.length
  }

  /** Returns true exactly once when a capture should be taken. */
  step(video: HTMLVideoElement, roi: Roi, now = performance.now()): boolean {
    if (!video.videoWidth) return false
    const g = this.gray(video, roi)
    this.motion = this.prev ? this.diff(g, this.prev) : 0
    this.prev = g

    switch (this.phase) {
      case 'idle': {
        if (this.motion > DISTURB) {
          if (++this.disturbFrames >= DISTURB_FRAMES) { this.phase = 'settling'; this.settleSince = now }
          return false
        }
        if (this.motion < MOTION_MAX) {
          this.disturbFrames = 0
          if (this.reference && this.diff(g, this.reference) > CHANGE_SLOW) { this.phase = 'settling'; this.settleSince = now }
        }
        return false
      }
      case 'settling': {
        if (this.motion > MOTION_MAX) { this.settleSince = now; return false }
        if (now - this.settleSince >= HOLD_MS) {
          this.phase = 'capture'
          this.captured = g.slice()
          this.change = this.reference ? this.diff(g, this.reference) : 1
          this.scans++
          return true
        }
        return false
      }
      case 'capture':
      case 'busy': {
        if (this.motion > DISTURB && ++this.disturbFrames >= DISTURB_FRAMES) this.disturbedWhileBusy = true
        return false
      }
    }
    return false
  }
}
