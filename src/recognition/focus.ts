/**
 * Sharpness estimate for the card region: Laplacian energy of the two text
 * bands (name at the top, number/illustrator at the bottom) normalised by the
 * bands' own contrast, so it is roughly independent of the card's artwork and
 * the lighting level. Rendered card art at full focus scores ~0.6–0.9; a 1px
 * defocus roughly halves it; 2px and beyond sits under ~0.15.
 */
import { grab, stagedSharpness, bandStats, SHARP_BANDS, STAGE_W } from './stage'

export const BLUR_THRESHOLD = 0.12

// Software scratch for bands of an already-captured card canvas (CPU → CPU, no GPU trip).
const scratch = document.createElement('canvas')
const sctx = scratch.getContext('2d', { willReadFrequently: true })!

/** Sharpness of a card already cropped to a canvas. */
export function sharpnessOf(card: HTMLCanvasElement): number {
  let lap = 0, variance = 0
  for (const [fx, fy, fw, fh] of SHARP_BANDS) {
    const sx = Math.round(fx * card.width), sy = Math.round(fy * card.height)
    const sw = Math.max(1, Math.round(fw * card.width)), sh = Math.max(1, Math.round(fh * card.height))
    const scale = Math.min(1, STAGE_W / sw)
    const w = Math.max(8, Math.round(sw * scale)), h = Math.max(8, Math.round(sh * scale))
    if (scratch.width !== w || scratch.height !== h) { scratch.width = w; scratch.height = h }
    sctx.drawImage(card, sx, sy, sw, sh, 0, 0, w, h)
    const d = sctx.getImageData(0, 0, w, h).data
    const l = new Float32Array(w * h)
    for (let i = 0, j = 0; i < d.length; i += 4, j++) l[j] = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 255
    const r = bandStats(l, w, 0, 0, w, h)
    lap += r.lap; variance += r.variance
  }
  return lap / (variance + 1e-4)
}

/**
 * Sharpness of the guide region straight from the live video. One frame draw and
 * one readback; used by the focus sweep, which samples on its own schedule.
 */
export function sharpnessOfVideo(video: HTMLVideoElement, roi: { x: number; y: number; w: number; h: number }): number {
  if (!grab(video, roi)) return 0
  return stagedSharpness()
}
