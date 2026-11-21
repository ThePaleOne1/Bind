/**
 * Running record of how the scanner is doing, for the report the phone can send to
 * the desk: a frame-rate sample every 10 s, a ring of timed events (settle, refocus,
 * capture, network) and the last scans with their OCR and timings.
 */
export interface PerfSample { t: number; fps: number; tick: number; factor: number; heap: number | null }
export interface PerfEvent { t: number; kind: string; note?: string; ms?: number }
export interface ScanLog {
  t: number; ms: number; ocrMs: number; tries: number; outcome: string
  card?: string; conf?: number; num?: string; name?: string; foil?: number; sharp?: number
}

const samples: PerfSample[] = []
const events: PerfEvent[] = []
const scans: ScanLog[] = []
const started = Date.now()
let lastSample = 0

const heapMb = () => {
  const m = (performance as any).memory
  return m?.usedJSHeapSize ? Math.round(m.usedJSHeapSize / 1048576) : null
}

/** Call often; records at most once every 10 s. */
export function samplePerf(fps: number, tick: number, factor: number) {
  const now = Date.now()
  if (now - lastSample < 10_000) return
  lastSample = now
  samples.push({ t: now, fps: Math.round(fps), tick: Math.round(tick * 10) / 10, factor: Math.round(factor * 100) / 100, heap: heapMb() })
  if (samples.length > 360) samples.shift()   // one hour
}

export function logEvent(kind: string, note?: string, ms?: number) {
  events.push({ t: Date.now(), kind, note, ms: ms == null ? undefined : Math.round(ms) })
  if (events.length > 200) events.shift()
}

/** Time an async step and log it. */
export async function timed<T>(kind: string, note: string | undefined, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now()
  try { return await fn() } finally { logEvent(kind, note, performance.now() - t0) }
}

export function logScan(s: Omit<ScanLog, 't'>) {
  scans.push({ t: Date.now(), ...s })
  if (scans.length > 40) scans.shift()
}

/** Everything the log holds, plus the basics about this device and session. */
export function baseReport(build: { id: string; version: string; time: string }) {
  return {
    at: new Date().toISOString(),
    build,
    sessionMinutes: Math.round((Date.now() - started) / 60000),
    ua: navigator.userAgent,
    screen: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
    heapMb: heapMb(),
    samples,
    events,
    scans,
  }
}
