import { createClient, type SupabaseClient, type Session } from '@supabase/supabase-js'
import { create } from 'zustand'
import { db, getMeta, setMeta } from '../data/db'
import { useSettings } from '../store/settings'
import type { Artist, BinderPage, OwnedCard } from '../data/types'

let client: SupabaseClient | null = null
let clientKey = ''

export function supabase(): SupabaseClient | null {
  const s = useSettings.getState()
  const url = s.supabaseUrl || import.meta.env.VITE_SUPABASE_URL || ''
  const key = s.supabaseKey || import.meta.env.VITE_SUPABASE_ANON_KEY || ''
  if (!url || !key) return null
  if (client && clientKey === url + key) return client
  client = createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true } })
  clientKey = url + key
  return client
}

interface AuthState {
  session: Session | null
  ready: boolean
  syncing: boolean
  lastSync: number | null
  error: string | null
  setSession: (s: Session | null) => void
}
export const useAuth = create<AuthState>((set) => ({
  session: null, ready: false, syncing: false, lastSync: null, error: null,
  setSession: (session) => set({ session, ready: true }),
}))

export async function initAuth() {
  const sb = supabase()
  if (!sb) { useAuth.setState({ ready: true }); return }
  const { data } = await sb.auth.getSession()
  useAuth.getState().setSession(data.session)
  sb.auth.onAuthStateChange((_e, session) => {
    useAuth.getState().setSession(session)
    if (session) void startSync()
  })
  if (data.session) void startSync()
}

export async function signIn(email: string, password: string) {
  const sb = supabase()
  if (!sb) throw new Error('Supabase not configured')
  const { error } = await sb.auth.signInWithPassword({ email, password })
  if (error) {
    // first time: create the account
    const { error: e2 } = await sb.auth.signUp({ email, password })
    if (e2) throw e2
  }
}
export async function signOut() { await supabase()?.auth.signOut() }

// ---------- sync ----------

const toRow = (o: Record<string, any>, uid: string) => {
  const { dirty, ...rest } = o
  return { ...snake(rest), user_id: uid }
}
const snake = (o: Record<string, any>) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase()), v]))
const camel = (o: Record<string, any>) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), v]))

let channelStarted = false
let timer: number | null = null

export async function startSync() {
  const sb = supabase()
  const session = useAuth.getState().session
  if (!sb || !session) return
  await syncNow()
  if (!channelStarted) {
    channelStarted = true
    sb.channel('db-changes')
      .on('postgres_changes', { event: '*', schema: 'public' }, () => scheduleSync())
      .subscribe()
    window.addEventListener('online', () => scheduleSync())
  }
}

export function scheduleSync(delay = 800) {
  if (timer) window.clearTimeout(timer)
  timer = window.setTimeout(() => void syncNow(), delay)
}

export async function syncNow() {
  const sb = supabase()
  const session = useAuth.getState().session
  if (!sb || !session || useAuth.getState().syncing) return
  const uid = session.user.id
  useAuth.setState({ syncing: true, error: null })
  try {
    // push
    const dirtyArtists = await db.artists.where('dirty').equals(1).toArray()
    const dirtyPages = await db.binderPages.where('dirty').equals(1).toArray()
    const dirtyOwned = await db.owned.where('dirty').equals(1).toArray()
    if (dirtyArtists.length) {
      const { error } = await sb.from('artists').upsert(dirtyArtists.map((a) => toRow(a, uid)), { onConflict: 'user_id,key' })
      if (error) throw error
      await db.artists.bulkPut(dirtyArtists.map((a) => ({ ...a, dirty: 0 })))
    }
    if (dirtyPages.length) {
      const { error } = await sb.from('binder_pages').upsert(dirtyPages.map((p) => toRow(p, uid)), { onConflict: 'user_id,page' })
      if (error) throw error
      await db.binderPages.bulkPut(dirtyPages.map((p) => ({ ...p, dirty: 0 })))
    }
    if (dirtyOwned.length) {
      let { error } = await sb.from('owned_cards').upsert(dirtyOwned.map((o) => toRow(o, uid)), { onConflict: 'id' })
      if (error && /finish/i.test(error.message)) {
        // The finish column has not been added on the server yet: sync everything else and say so.
        ;({ error } = await sb.from('owned_cards').upsert(dirtyOwned.map(({ finish, ...o }) => toRow(o, uid)), { onConflict: 'id' }))
        await setMeta('syncWarn', 'Card finishes are not syncing: run supabase/migrations/2026-11-21-finish.sql in the Supabase SQL editor.')
      } else if (!error) await setMeta('syncWarn', '')
      if (error) throw error
      await db.owned.bulkPut(dirtyOwned.map((o) => ({ ...o, dirty: 0 })))
    }
    // pull
    const last = (await getMeta<number>('lastPull'))?.value ?? 0
    const pullAt = Date.now()
    const [a, p, o] = await Promise.all([
      sb.from('artists').select('*').gt('updated_at', last),
      sb.from('binder_pages').select('*').gt('updated_at', last),
      sb.from('owned_cards').select('*').gt('updated_at', last),
    ])
    for (const r of [a, p, o]) if (r.error) throw r.error
    await db.transaction('rw', db.artists, db.binderPages, db.owned, async () => {
      for (const row of a.data ?? []) {
        const { userId, ...rest } = camel(row) as any
        const local = await db.artists.get(rest.key)
        if (!local || (local.updatedAt ?? 0) < rest.updatedAt) await db.artists.put({ ...(rest as Artist), dirty: 0 })
      }
      for (const row of p.data ?? []) {
        const { userId, ...rest } = camel(row) as any
        const local = await db.binderPages.get(rest.page)
        if (!local || (local.updatedAt ?? 0) < rest.updatedAt) await db.binderPages.put({ ...(rest as BinderPage), dirty: 0 })
      }
      for (const row of o.data ?? []) {
        const { userId, ...rest } = camel(row) as any
        const local = await db.owned.get(rest.id)
        if (!local || (local.updatedAt ?? 0) < rest.updatedAt) await db.owned.put({ ...(rest as OwnedCard), dirty: 0 })
      }
    })
    await setMeta('lastPull', pullAt)
    useAuth.setState({ lastSync: Date.now() })
  } catch (e: any) {
    useAuth.setState({ error: e.message ?? String(e) })
  } finally {
    useAuth.setState({ syncing: false })
  }
}
