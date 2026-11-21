/**
 * Lightweight canvas particle bursts for the scan result. No deps.
 */
interface P { x: number; y: number; vx: number; vy: number; life: number; max: number; size: number; color: string; spin: number; rot: number; shape: 0 | 1 }

export class Particles {
  private ps: P[] = []
  private raf = 0
  private ctx: CanvasRenderingContext2D
  private w = 0
  private h = 0
  /** Phones get fewer, cheaper particles: the camera and OCR already have the CPU busy. */
  private budget = window.matchMedia('(max-width: 959px)').matches ? 0.5 : 1
  private startedAt = 0
  private lastT = 0
  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!
    this.resize()
  }
  resize() {
    // A full-screen canvas is re-uploaded to the GPU every frame it changes, on top of
    // the live video. Phones get it at 0.75x: soft confetti does not need more.
    const dpr = Math.min(this.budget < 1 ? 0.75 : 2, window.devicePixelRatio || 1)
    const r = this.canvas.getBoundingClientRect()
    this.w = r.width; this.h = r.height
    this.canvas.width = r.width * dpr
    this.canvas.height = r.height * dpr
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }
  /** Burst from a point (CSS px). colors: array of CSS colors. */
  burst(x: number, y: number, colors: string[], count = 90, power = 1) {
    count = Math.round(count * this.budget)
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2
      const sp = (4 + Math.random() * 9) * power
      this.ps.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 4 * power,
        life: 0, max: 0.85 + Math.random() * 0.65, size: 3 + Math.random() * 5,
        color: colors[(Math.random() * colors.length) | 0], spin: (Math.random() - 0.5) * 0.3, rot: Math.random() * 6,
        shape: Math.random() < 0.5 ? 0 : 1,
      })
    }
    this.loop()
  }
  /** Ring sweep around a rectangle (CSS px) — used when a card is locked. */
  ring(cx: number, cy: number, radius: number, colors: string[], count = 60) {
    count = Math.round(count * this.budget)
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2
      this.ps.push({
        x: cx + Math.cos(a) * radius, y: cy + Math.sin(a) * radius,
        vx: Math.cos(a) * 2.2, vy: Math.sin(a) * 2.2 - 0.6,
        life: 0, max: 0.65 + Math.random() * 0.35, size: 2 + Math.random() * 3,
        color: colors[(Math.random() * colors.length) | 0], spin: 0, rot: 0, shape: 0,
      })
    }
    this.loop()
  }
  private loop = () => {
    cancelAnimationFrame(this.raf)
    this.startedAt = performance.now()
    this.lastT = this.startedAt
    const tick = (now: number) => {
      const { ctx } = this
      // Time-based, so a dropped frame rate shortens nothing and lengthens nothing;
      // and a hard stop at 2.5 s whatever happens.
      const dt = Math.min(3, (now - this.lastT) / (1000 / 60))
      this.lastT = now
      if (now - this.startedAt > 2500) this.ps = []
      ctx.clearRect(0, 0, this.w, this.h)
      this.ps = this.ps.filter((p) => p.life < p.max)
      for (const p of this.ps) {
        p.life += dt / 60
        p.vy += 0.18 * dt
        p.vx *= Math.pow(0.985, dt)
        p.vy *= Math.pow(0.985, dt)
        p.x += p.vx * dt
        p.y += p.vy * dt
        p.rot += p.spin * dt
        const t = 1 - p.life / p.max
        ctx.globalAlpha = Math.min(1, t * 1.6)
        ctx.fillStyle = p.color
        if (p.shape === 0) {
          ctx.beginPath(); ctx.arc(p.x, p.y, p.size * t, 0, Math.PI * 2); ctx.fill()
        } else {
          ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot)
          ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2)
          ctx.restore()
        }
      }
      ctx.globalAlpha = 1
      if (this.ps.length) this.raf = requestAnimationFrame(tick)
      else ctx.clearRect(0, 0, this.w, this.h)
    }
    this.raf = requestAnimationFrame(tick)
  }
  destroy() { cancelAnimationFrame(this.raf) }
}

export const PALETTES = {
  collecting: ['#19d3a2', '#2be8b5', '#9ff0d8', '#e9f5f0'],
  'not-collecting': ['#7fa699', '#b9d6cc', '#58807a'],
  unknown: ['#9b7bff', '#c8b8ff', '#e9f5f0', '#19d3a2'],
  value: ['#ff4d9d', '#ffa3cf', '#ffffff', '#ff7ab8'],
  remove: ['#ff4d6d', '#ff8da1', '#ffd3db'],
}
