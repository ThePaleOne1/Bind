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
 *
 * Each step() touches the camera frame once (see stage.ts); the sharpness of that
 * same frame is available through sharpness() at no extra GPU cost.
 */
import { grab, grabGrid, stagedSharpness, stagedContrast } from './stage'

export type Phase = 'idle' | 'settling' | 'capture' | 'busy'

export interface Roi { x: number; y: number; w: number; h: number } // fractions of the video frame

const HOLD_MS = 350
const MOTION_MAX = 0.025        // frame-to-frame change considered "still"
const DISTURB = 0.035          // frame-to-frame change considered "something moved"
const DISTURB_FRAMES = 1        // one frame of real motion (3.5% of the card region changing) is plenty at 5 fps
const CHANGE_SLOW = 0.09        // still frame differing this much from the last scan → new card placed gently

export class FrameAnalyzer {
  private prev: Float32Array | null = null
  private cur: Float32Array | null = null
  private reference: Float32Array | null = null  // the frame last scanned
  private captured: Float32Array | null = null
  private settleSince = 0
  private disturbFrames = 0
  private disturbedWhileBusy = false
  private sharp: number | null = null
  private staged = false          // the 480-wide stage holds this step's frame
  private video: HTMLVideoElement | null = null
  private roi: Roi | null = null
  phase: Phase = 'settling'   // scan whatever is in frame once the picture is stable
  motion = 0
  /** How much the frame just captured differs from the previous scan (0 = identical). */
  change = 1
  scans = 0

  constructor() {
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

  /** Sharpness of the current frame. Free while settling (the stage is read anyway); otherwise one extra grab. */
  sharpness(): number {
    if (this.sharp != null) return this.sharp
    if (!this.staged) { if (!this.video || !this.roi || !grab(this.video, this.roi)) return 0; this.staged = true }
    this.sharp = stagedSharpness()
    return this.sharp
  }

  /** Brightness spread of the current frame. */
  contrast(): number {
    if (!this.staged) { if (!this.video || !this.roi || !grab(this.video, this.roi)) return 0; this.staged = true }
    return stagedContrast()
  }

  private diff(a: Float32Array, b: Float32Array) {
    let s = 0
    for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i])
    return s / a.length
  }

  /** Returns true exactly once when a capture should be taken. */
  step(video: HTMLVideoElement, roi: Roi, now = performance.now()): boolean {
    this.video = video; this.roi = roi
    this.sharp = null; this.staged = false
    // two grids, swapped each step: no allocation per frame
    const g = this.prev && this.prev !== this.cur ? this.prev : new Float32Array(48 * 64)
    if (!grabGrid(video, roi, g)) return false
    // while a card settles its focus matters: read the 480-wide stage too (one more round-trip)
    if (this.phase === 'settling') this.staged = grab(video, roi)
    this.motion = this.cur ? this.diff(g, this.cur) : 0
    this.prev = this.cur
    this.cur = g

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

/**
 * Self-throttling tick scheduler. Each tick reports how long its work took; when
 * the work costs more than its budget, or the page's own frames start arriving
 * late (the main thread is busy), the interval stretches, up to 3x. When things
 * are cheap again it creeps back to the base rate. The phone must never feel the
 * loop: a scan starting half a second later is fine, a stuttering phone is not.
 */
export class Pacer {
  cost = 0            // smoothed ms of work per tick
  gap = 16            // smoothed ms between animation frames (16 = smooth 60 fps)
  factor = 1          // current slowdown multiplier
  private lastFrame = 0
  /** `duty` is the share of wall time the loop may spend working (0.15 = 15%). */
  constructor(private duty = 0.15) {}
  /** Call once per animation frame, before deciding whether to work. */
  frame(t: number) {
    if (this.lastFrame) this.gap = this.gap * 0.9 + Math.min(200, t - this.lastFrame) * 0.1
    this.lastFrame = t
  }
  /** Call with the ms a tick's work took and the base interval it ran at. */
  worked(ms: number, baseMs: number) {
    this.cost = this.cost * 0.8 + ms * 0.2
    const byCost = this.cost / (this.duty * baseMs)          // 1 when exactly on budget
    const byJank = this.gap > 33 ? 1.5 : 1                    // page under 30 fps: ease off
    const want = Math.min(3, Math.max(1, byCost, byJank))
    this.factor = want > this.factor ? want : this.factor * 0.9 + want * 0.1   // back off fast, relax slowly
  }
  /** Interval to use for a given base interval. */
  interval(baseMs: number) { return baseMs * this.factor }
}
