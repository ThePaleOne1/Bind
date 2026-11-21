/**
 * One place where the live camera frame is touched.
 *
 * Every drawImage(video) makes the browser copy the current camera frame (33 MB
 * at 4K) into a texture, and every getImageData after it stalls the main thread
 * until the GPU has finished. Doing that a dozen times a second for motion
 * detection and again for every sharpness sample is what made the whole phone
 * crawl. So per analysis tick the frame is drawn exactly once, scaled down to
 * STAGE_W wide, read back exactly once, and everything the loop wants to know
 * (motion grey, sharpness of the text bands) is computed in JS from that one
 * small buffer.
 */
import type { Roi } from './frameAnalyzer'

export const STAGE_W = 480     // sharpness numbers were calibrated at 480 px band width: keep it
const GRID_W = 48, GRID_H = 64 // motion grid

// Sharpness bands as fractions of the card: name at the top, number/illustrator at the bottom
export const SHARP_BANDS: [number, number, number, number][] = [
  [0, 0, 1, 0.16],
  [0, 0.82, 1, 0.18],
]

const gpu = document.createElement('canvas')
const gctx = gpu.getContext('2d')!
const sw = document.createElement('canvas')
const sctx = sw.getContext('2d', { willReadFrequently: true })!

// Motion path: the frame goes straight down to the 48x64 grid on the GPU and only
// 12 KB comes back. This runs every tick; the 480-wide stage below only while a card
// is settling and its sharpness matters.
const gpuSmall = document.createElement('canvas')
gpuSmall.width = GRID_W; gpuSmall.height = GRID_H
const gsctx = gpuSmall.getContext('2d')!
const swSmall = document.createElement('canvas')
swSmall.width = GRID_W; swSmall.height = GRID_H
const ssctx = swSmall.getContext('2d', { willReadFrequently: true })!

/** 48x64 mean-luminance grid of the guide region, read with one tiny GPU round-trip. */
export function grabGrid(video: HTMLVideoElement, roi: Roi, out: Float32Array): boolean {
  const vw = video.videoWidth, vh = video.videoHeight
  if (!vw) return false
  gsctx.drawImage(video, roi.x * vw, roi.y * vh, roi.w * vw, roi.h * vh, 0, 0, GRID_W, GRID_H)
  ssctx.drawImage(gpuSmall, 0, 0)
  const d = ssctx.getImageData(0, 0, GRID_W, GRID_H).data
  for (let i = 0, j = 0; i < d.length; i += 4, j++) out[j] = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 255
  return true
}

let data: Uint8ClampedArray | null = null
let W = 0, H = 0
let lum: Float32Array | null = null
let lumDirty = true

/** Draw the guide region of the live frame into the stage and read it back (one GPU round-trip). */
export function grab(video: HTMLVideoElement, roi: Roi): boolean {
  const vw = video.videoWidth, vh = video.videoHeight
  if (!vw) return false
  const w = STAGE_W
  const h = Math.max(8, Math.round(STAGE_W * (roi.h * vh) / Math.max(1, roi.w * vw)))
  if (gpu.width !== w || gpu.height !== h) { gpu.width = w; gpu.height = h }
  if (sw.width !== w || sw.height !== h) { sw.width = w; sw.height = h }
  gctx.drawImage(video, roi.x * vw, roi.y * vh, roi.w * vw, roi.h * vh, 0, 0, w, h)
  sctx.drawImage(gpu, 0, 0)
  data = sctx.getImageData(0, 0, w, h).data
  W = w; H = h; lumDirty = true
  return true
}

/** Luminance (0–1) of the staged frame, computed once per grab. */
function luminance(): Float32Array {
  if (!lumDirty && lum) return lum
  const d = data!
  if (!lum || lum.length !== W * H) lum = new Float32Array(W * H)
  for (let i = 0, j = 0; i < d.length; i += 4, j++) lum[j] = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 255
  lumDirty = false
  return lum
}

/** 48x64 mean-luminance grid of the staged frame, for motion/change detection. */
export function motionGrid(out?: Float32Array): Float32Array {
  const g = out && out.length === GRID_W * GRID_H ? out : new Float32Array(GRID_W * GRID_H)
  if (!data) return g
  const l = luminance()
  for (let gy = 0; gy < GRID_H; gy++) {
    const y0 = Math.floor(gy * H / GRID_H), y1 = Math.max(y0 + 1, Math.floor((gy + 1) * H / GRID_H))
    for (let gx = 0; gx < GRID_W; gx++) {
      const x0 = Math.floor(gx * W / GRID_W), x1 = Math.max(x0 + 1, Math.floor((gx + 1) * W / GRID_W))
      let s = 0
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) s += l[y * W + x]
      g[gy * GRID_W + gx] = s / ((y1 - y0) * (x1 - x0))
    }
  }
  return g
}

/** Laplacian energy and variance of a band of a luminance buffer. */
export function bandStats(l: Float32Array, w: number, x0: number, y0: number, bw: number, bh: number): { lap: number; variance: number } {
  let s = 0, s2 = 0, n0 = 0
  for (let y = y0; y < y0 + bh; y++) for (let x = x0; x < x0 + bw; x++) { const v = l[y * w + x]; s += v; s2 += v * v; n0++ }
  const m = s / Math.max(1, n0)
  const variance = s2 / Math.max(1, n0) - m * m
  let ls = 0, ls2 = 0, n = 0
  for (let y = y0 + 1; y < y0 + bh - 1; y++) {
    for (let x = x0 + 1; x < x0 + bw - 1; x++) {
      const i = y * w + x
      const v = 4 * l[i] - l[i - 1] - l[i + 1] - l[i - w] - l[i + w]
      ls += v; ls2 += v * v; n++
    }
  }
  const lm = ls / Math.max(1, n)
  return { lap: n ? ls2 / n - lm * lm : 0, variance }
}

/** Sharpness of the text bands of the staged frame (same scale as focus.ts). */
export function stagedSharpness(): number {
  if (!data) return 0
  const l = luminance()
  let lap = 0, variance = 0
  for (const [fx, fy, fw, fh] of SHARP_BANDS) {
    const r = bandStats(l, W, Math.round(fx * W), Math.round(fy * H), Math.max(8, Math.round(fw * W)), Math.max(8, Math.round(fh * H)))
    lap += r.lap; variance += r.variance
  }
  return lap / (variance + 1e-4)
}

/** Brightness standard deviation (0–1) of the staged frame: a printed card is busy, a bare jig is flat. */
export function stagedContrast(): number {
  if (!data) return 0
  const l = luminance()
  let s = 0, s2 = 0
  for (let i = 0; i < l.length; i++) { s += l[i]; s2 += l[i] * l[i] }
  const m = s / l.length
  return Math.sqrt(Math.max(0, s2 / l.length - m * m))
}
