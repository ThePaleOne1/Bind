/**
 * The capture pipeline shared by the scanner and the test bench: where the guide box
 * is, a full-resolution grab of the region around it, and the card located inside.
 */
import type { CameraHandle } from './camera'
import type { Roi } from './frameAnalyzer'
import { captureRoi, grabRegion, cropCanvas } from './recognizer'
import { findCard } from './bounds'

/** Guide region: card aspect 63:88 centred, 74% of the shorter side wide (fractions of the video). */
export function guideRoi(video: HTMLVideoElement | null): Roi {
  if (!video || !video.videoWidth) return { x: 0.2, y: 0.2, w: 0.6, h: 0.6 }
  const vw = video.videoWidth, vh = video.videoHeight
  const el = video.getBoundingClientRect()
  // object-fit: cover → compute visible region of the video in video pixels
  const scale = Math.max(el.width / vw, el.height / vh)
  const visW = el.width / scale, visH = el.height / scale
  const portrait = el.height > el.width
  const cardW = portrait ? visW * 0.74 : visH * 0.62 * (63 / 88)
  const cardH = cardW * (88 / 63)
  return { x: (vw - cardW) / 2 / vw, y: (vh - cardH) / 2 / vh - (portrait ? 0.03 : 0), w: cardW / vw, h: cardH / vh }
}

/** The guide box grown by 15% each side: the region the card is looked for in. */
export function widen(g: Roi): Roi {
  const mx = g.w * 0.15, my = g.h * 0.15
  const x = Math.max(0, g.x - mx), y = Math.max(0, g.y - my)
  return { x, y, w: Math.min(1 - x, g.w + 2 * mx), h: Math.min(1 - y, g.h + 2 * my) }
}

/** Where a region of the video lands on screen (the video is object-fit: cover). */
export function roiToScreen(video: HTMLVideoElement, r: Roi): { left: number; top: number; width: number; height: number } {
  const el = video.getBoundingClientRect()
  const vw = video.videoWidth, vh = video.videoHeight
  const scale = Math.max(el.width / vw, el.height / vh)
  const offX = (el.width - vw * scale) / 2, offY = (el.height - vh * scale) / 2
  return { left: offX + r.x * vw * scale, top: offY + r.y * vh * scale, width: r.w * vw * scale, height: r.h * vh * scale }
}

// A still from the sensor may arrive in sensor orientation; it is turned upright here
// (software canvas: a 4K rotation is a CPU job and this one is reused).
const uprightCanvas = document.createElement('canvas')
function upright(bmp: ImageBitmap, portrait: boolean): { src: CanvasImageSource; w: number; h: number } {
  const landscape = bmp.width > bmp.height
  if (landscape !== portrait) return { src: bmp, w: bmp.width, h: bmp.height }
  if (uprightCanvas.width !== bmp.height || uprightCanvas.height !== bmp.width) { uprightCanvas.width = bmp.height; uprightCanvas.height = bmp.width }
  const ctx = uprightCanvas.getContext('2d', { willReadFrequently: true })!
  ctx.save(); ctx.translate(bmp.height, 0); ctx.rotate(Math.PI / 2); ctx.drawImage(bmp, 0, 0); ctx.restore()
  return { src: uprightCanvas, w: uprightCanvas.width, h: uprightCanvas.height }
}

/**
 * Full-resolution picture of the wide region: a still from the sensor when the lens
 * can take one (the preview runs at 720p and is too small to read), else the preview.
 */
export async function grabWide(video: HTMLVideoElement, cam: CameraHandle | null, wide: Roi, avoid?: HTMLCanvasElement): Promise<{ canvas: HTMLCanvasElement; still: boolean }> {
  if (cam && cam.canStill()) {
    const bmp = await cam.still()
    if (bmp) {
      const vw = video.videoWidth, vh = video.videoHeight
      const u = upright(bmp, vh > vw)
      // Same horizontal field of view as the preview; a taller still is centred on it.
      const s = u.w / vw
      const y0 = (u.h - vh * s) / 2
      const r = { x: wide.x * vw * s, y: y0 + wide.y * vh * s, w: wide.w * vw * s, h: wide.h * vh * s }
      r.x = Math.max(0, r.x); r.y = Math.max(0, r.y); r.w = Math.min(u.w - r.x, r.w); r.h = Math.min(u.h - r.y, r.h)
      const c = grabRegion(u.src, r, avoid)
      bmp.close()
      return { canvas: c, still: true }
    }
  }
  return { canvas: captureRoi(video, wide, avoid), still: false }
}

export interface Located { canvas: HTMLCanvasElement; found: boolean; roi: Roi; moved: boolean }

/**
 * Find the card inside a wide grab and crop it out. `prev` is where it was last seen
 * (used when the edges cannot be found this time); `roi` in the result is where it is
 * now, in video fractions, and `moved` says it differs from `prev`/the guide by over 1%.
 */
export function locateCard(frame: HTMLCanvasElement, wide: Roi, guide: Roi, prev: Roi | null, video: HTMLVideoElement, avoid?: HTMLCanvasElement): Located {
  const vw = video.videoWidth, vh = video.videoHeight
  const scale = frame.width / (wide.w * vw)
  const toFrame = (r: Roi) => ({ x: (r.x - wide.x) * vw * scale, y: (r.y - wide.y) * vh * scale, w: r.w * vw * scale, h: r.h * vh * scale })
  const guideF = toFrame(guide)
  const found = findCard(frame, guideF)
  const r = found ?? (prev ? toFrame(prev) : guideF)
  const roi: Roi = found ? { x: wide.x + r.x / scale / vw, y: wide.y + r.y / scale / vh, w: r.w / scale / vw, h: r.h / scale / vh } : (prev ?? guide)
  const cur = prev ?? guide
  const moved = !!found && (Math.abs(roi.x - cur.x) > 0.01 || Math.abs(roi.y - cur.y) > 0.01 || Math.abs(roi.w - cur.w) > 0.01 || Math.abs(roi.h - cur.h) > 0.01)
  return { canvas: cropCanvas(frame, r, avoid), found: !!found, roi, moved }
}

/** A small JPEG of a canvas (data URL), for reports. */
export function thumb(src: HTMLCanvasElement, maxH = 640, quality = 0.55): string {
  const sc = Math.min(1, maxH / src.height)
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(src.width * sc)); c.height = Math.max(1, Math.round(src.height * sc))
  c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height)
  return c.toDataURL('image/jpeg', quality)
}
