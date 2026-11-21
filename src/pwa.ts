/**
 * Service-worker lifecycle + manual update controls.
 *
 * - `version.json` is emitted at build time and is never precached, so fetching
 *   it with `cache: 'no-store'` always tells us what the server currently has.
 * - `checkForUpdate()` compares that with the build baked into this bundle and
 *   asks the browser to re-check the service worker.
 * - `forceRefresh()` is the sledgehammer: unregister every worker, drop the app
 *   caches (keeping card images), reload with a cache-busting query.
 */
import { registerSW } from 'virtual:pwa-register'
import { create } from 'zustand'

export const BUILD = { version: __APP_VERSION__, id: __BUILD_ID__, time: __BUILD_TIME__ }

interface LiveBuild { version: string; id: string; time: string }
interface PwaState {
  registration: ServiceWorkerRegistration | null
  updateReady: boolean      // a new worker is installed and waiting
  live: LiveBuild | null    // what the server is serving right now
  checking: boolean
  lastCheck: number | null
  offline: boolean
}
export const usePwa = create<PwaState>(() => ({
  registration: null, updateReady: false, live: null, checking: false, lastCheck: null, offline: false,
}))

let updateSW: ((reload?: boolean) => Promise<void>) | null = null

export function initPwa() {
  updateSW = registerSW({
    immediate: true,
    onRegisteredSW(_url, reg) {
      usePwa.setState({ registration: reg ?? null })
      if (!reg) return
      // Re-check whenever the app comes back to the foreground, and hourly.
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void reg.update().catch(() => {}) })
      setInterval(() => void reg.update().catch(() => {}), 60 * 60 * 1000)
    },
    onNeedRefresh() {
      usePwa.setState({ updateReady: true })
    },
  })
}

export const isNewer = (live: LiveBuild | null) => !!live && live.id !== BUILD.id

export async function checkForUpdate(): Promise<'current' | 'available' | 'offline'> {
  usePwa.setState({ checking: true })
  try {
    const base = import.meta.env.BASE_URL
    const r = await fetch(`${base}version.json?t=${Date.now()}`, { cache: 'no-store' })
    if (!r.ok) throw new Error(String(r.status))
    const live = (await r.json()) as LiveBuild
    usePwa.setState({ live, offline: false, lastCheck: Date.now() })
    const reg = usePwa.getState().registration
    if (reg) await reg.update().catch(() => {})
    return isNewer(live) || usePwa.getState().updateReady ? 'available' : 'current'
  } catch {
    usePwa.setState({ offline: true, lastCheck: Date.now() })
    return 'offline'
  } finally {
    usePwa.setState({ checking: false })
  }
}

/** Apply a waiting update if there is one, otherwise hard-refresh. */
export async function applyUpdate() {
  if (usePwa.getState().updateReady && updateSW) {
    await updateSW(true)
    // updateSW reloads the page; if we are still here after a moment, fall through.
    await new Promise((r) => setTimeout(r, 1500))
  }
  await forceRefresh()
}

export async function forceRefresh() {
  try {
    const regs = await navigator.serviceWorker?.getRegistrations?.() ?? []
    await Promise.all(regs.map((r) => r.unregister()))
    const keys = await caches.keys()
    await Promise.all(keys.filter((k) => k !== 'card-images').map((k) => caches.delete(k)))
  } catch { /* best effort */ }
  const url = new URL(location.href)
  url.searchParams.set('v', String(Date.now()))
  location.replace(url.toString())
}
