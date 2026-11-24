/**
 * Phone ⇄ desktop live link. Uses a Supabase Realtime broadcast channel when
 * signed in (works across networks) and falls back to a BrowserChannel so two
 * tabs of the same browser can talk during development.
 */
import type { RealtimeChannel } from '@supabase/supabase-js'
import type { ScanEvent } from '../data/types'
import { supabase, useAuth } from './supabase'

export interface CompanionMessage {
  type: 'scan' | 'hello' | 'report' | 'report-images' | 'report-crop'
  from: string
  at: number
  scan?: ScanEvent
  /** Diagnostic report from the phone (see utils/perfLog); images travel separately. */
  report?: any
}

type Listener = (m: CompanionMessage) => void
const listeners = new Set<Listener>()
const deviceId = (() => {
  const k = 'bind-device'
  let v = localStorage.getItem(k)
  if (!v) { v = Math.random().toString(36).slice(2, 8); localStorage.setItem(k, v) }
  return v
})()

let bc: BroadcastChannel | null = null
let rt: RealtimeChannel | null = null
let rtUid = ''

function ensure() {
  if (!bc && 'BroadcastChannel' in window) {
    bc = new BroadcastChannel('bind-companion')
    bc.onmessage = (e) => dispatch(e.data)
  }
  const sb = supabase()
  const uid = useAuth.getState().session?.user.id
  if (sb && uid && rtUid !== uid) {
    rt?.unsubscribe()
    rt = sb.channel(`companion-${uid}`, { config: { broadcast: { self: false } } })
    rt.on('broadcast', { event: 'msg' }, (p) => dispatch(p.payload as CompanionMessage)).subscribe()
    rtUid = uid
  }
}

function dispatch(m: CompanionMessage) {
  if (!m || m.from === deviceId) return
  listeners.forEach((l) => l(m))
}

export function onCompanion(l: Listener) {
  ensure()
  listeners.add(l)
  return () => { listeners.delete(l) }
}

/** Resolves true when the message went out over the live link (false: local only, or refused). */
export async function sendCompanion(partial: Omit<CompanionMessage, 'from' | 'at'>): Promise<boolean> {
  ensure()
  const m: CompanionMessage = { ...partial, from: deviceId, at: Date.now() }
  bc?.postMessage(m)
  if (!rt) return false
  try { return (await rt.send({ type: 'broadcast', event: 'msg', payload: m })) === 'ok' } catch { return false }
}

export const companionConnected = () => { ensure(); return !!rt }
