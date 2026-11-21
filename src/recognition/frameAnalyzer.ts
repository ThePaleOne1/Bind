/**
 * Watches the guide region of the camera feed and decides, hands-free, when a
 * card has been placed and is being held still — and when it has been removed.
 *
 *   EMPTY ──(presence high, motion low for HOLD_MS)──▶ CAPTURE
 *   CAPTURE ──▶ BUSY (recognising / showing result)
 *   BUSY ──(frame differs a lot from the captured one)──▶ EMPTY (re-armed)
 */
export type Phase = 'empty' | 'settling' | 'capture' | 'busy'

export interface Roi { x: number; y: number; w: number; h: number } // fractions of the video frame

const W = 48
const H = 64
const HOLD_MS = 350
const PRESENCE_ON = 0.09
const MOTION_MAX = 0.025
const CHANGE_REARM = 0.14

export class FrameAnalyzer {
  private canvas = document.createElement('canvas')
  private ctx = this.canvas.getContext('2d', { willReadFrequently: true })!
  private bg: Float32Array | null = null
  private prev: Float32Array | null = null
  private captured: Float32Array | null = null
  private settleSince = 0
  phase: Phase = 'empty'
  presence = 0
  motion = 0
  sharpness = 0

  constructor() {
    this.canvas.width = W
    this.canvas.height = H
  }

  reset() {
    this.bg = null
    this.prev = null
    this.captured = null
    this.phase = 'empty'
  }

  /** Call when the recognition pipeline is done with the current card. */
  release() {
    // stay busy until the card is physically removed/replaced; handled in step()
    if (this.phase === 'capture') this.phase = 'busy'
  }

  private gray(video: HTMLVideoElement, roi: Roi): Float32Array {
    const vw = video.videoWidth, vh = video.videoHeight
    this.ctx.drawImage(video, roi.x * vw, roi.y * vh, roi.w * vw, roi.h * vh, 0, 0, W, H)
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

  private laplacianVar(g: Float32Array) {
    let sum = 0, sum2 = 0, n = 0
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x
        const l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - W] - g[i + W]
        sum += l; sum2 += l * l; n++
      }
    }
    const m = sum / n
    return sum2 / n - m * m
  }

  /** Returns true exactly once when a capture should be taken. */
  step(video: HTMLVideoElement, roi: Roi, now = performance.now()): boolean {
    if (!video.videoWidth) return false
    const g = this.gray(video, roi)
    this.motion = this.prev ? this.diff(g, this.prev) : 1
    this.prev = g
    if (!this.bg) { this.bg = g.slice(); return false }
    this.presence = this.diff(g, this.bg)
    this.sharpness = this.laplacianVar(g)

    switch (this.phase) {
      case 'empty': {
        if (this.presence < PRESENCE_ON) {
          // slowly adapt the background while nothing is in frame
          if (this.motion < MOTION_MAX) for (let i = 0; i < g.length; i++) this.bg[i] += (g[i] - this.bg[i]) * 0.05
          return false
        }
        this.phase = 'settling'
        this.settleSince = now
        return false
      }
      case 'settling': {
        if (this.presence < PRESENCE_ON) { this.phase = 'empty'; return false }
        if (this.motion > MOTION_MAX) { this.settleSince = now; return false }
        if (now - this.settleSince >= HOLD_MS) {
          this.phase = 'capture'
          this.captured = g.slice()
          return true
        }
        return false
      }
      case 'capture':
        return false
      case 'busy': {
        if (!this.captured) { this.phase = 'empty'; return false }
        const change = this.diff(g, this.captured)
        if (change > CHANGE_REARM && this.motion < MOTION_MAX * 2) {
          // card removed (back to background) or swapped for a new one
          this.phase = this.presence < PRESENCE_ON ? 'empty' : 'settling'
          this.settleSince = now
          this.captured = null
        }
        return false
      }
    }
    return false
  }
}
