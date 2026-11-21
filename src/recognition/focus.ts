/**
 * Sharpness estimate for the card region: Laplacian energy of the two text
 * bands (name at the top, number/illustrator at the bottom) normalised by the
 * bands' own contrast, so it is roughly independent of the card's artwork and
 * the lighting level. Rendered card art at full focus scores ~0.6–0.9; a 1px
 * defocus roughly halves it; 2px and beyond sits under ~0.15.
 */
export const BLUR_THRESHOLD = 0.12

const BANDS: [number, number, number, number][] = [
  [0, 0, 1, 0.16],
  [0, 0.82, 1, 0.18],
]
const MAX_W = 480

// GPU-backed canvas does the crop/downscale of the live frame; the software
// canvas only ever receives the small result (see FrameAnalyzer for why).
const gpu = document.createElement('canvas')
const gctx = gpu.getContext('2d')!
const scratch = document.createElement('canvas')
const sctx = scratch.getContext('2d', { willReadFrequently: true })!

function bandSharpness(src: CanvasImageSource, sx: number, sy: number, sw: number, sh: number): { lap: number; variance: number } {
  const scale = Math.min(1, MAX_W / sw)
  const w = Math.max(8, Math.round(sw * scale)), h = Math.max(8, Math.round(sh * scale))
  if (gpu.width !== w || gpu.height !== h) { gpu.width = w; gpu.height = h }
  if (scratch.width !== w || scratch.height !== h) { scratch.width = w; scratch.height = h }
  gctx.drawImage(src, sx, sy, sw, sh, 0, 0, w, h)
  sctx.drawImage(gpu, 0, 0)
  const d = sctx.getImageData(0, 0, w, h).data
  const g = new Float32Array(w * h)
  let s = 0, s2 = 0
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    const v = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 255
    g[j] = v; s += v; s2 += v * v
  }
  const m = s / g.length
  const variance = s2 / g.length - m * m
  let ls = 0, ls2 = 0, n = 0
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w]
      ls += l; ls2 += l * l; n++
    }
  }
  const lm = ls / n
  return { lap: ls2 / n - lm * lm, variance }
}

/** Sharpness of a card already cropped to a canvas. */
export function sharpnessOf(card: HTMLCanvasElement): number {
  let lap = 0, variance = 0
  for (const [fx, fy, fw, fh] of BANDS) {
    const r = bandSharpness(card, Math.round(fx * card.width), Math.round(fy * card.height), Math.round(fw * card.width), Math.round(fh * card.height))
    lap += r.lap; variance += r.variance
  }
  return lap / (variance + 1e-4)
}

/** Sharpness of the guide region straight from the live video (fractions of the frame). */
export function sharpnessOfVideo(video: HTMLVideoElement, roi: { x: number; y: number; w: number; h: number }): number {
  const vw = video.videoWidth, vh = video.videoHeight
  if (!vw) return 0
  let lap = 0, variance = 0
  for (const [fx, fy, fw, fh] of BANDS) {
    const r = bandSharpness(
      video,
      Math.round((roi.x + fx * roi.w) * vw), Math.round((roi.y + fy * roi.h) * vh),
      Math.round(fw * roi.w * vw), Math.round(fh * roi.h * vh),
    )
    lap += r.lap; variance += r.variance
  }
  return lap / (variance + 1e-4)
}
