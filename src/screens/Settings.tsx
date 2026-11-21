import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Settings as Cog, Download, Upload, RefreshCw, LogOut, Cloud, CloudOff, Trash2 } from 'lucide-react'
import { db } from '../data/db'
import { indexStatus, loadIndex } from '../api/tcgdex'
import { useSettings } from '../store/settings'
import { exportJson, importJson } from '../store/collection'
import { signIn, signOut, supabase, syncNow, useAuth } from '../sync/supabase'
import { Stepper, Switch, Title, TitleBar, toast } from '../components/ui'
import { fmtAud } from '../utils/price'


export default function Settings() {
  const s = useSettings()
  const auth = useAuth()
  const [idx, setIdx] = useState<{ count: number; at: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [email, setEmail] = useState('')
  const [pw, setPw] = useState('')
  const [showKeys, setShowKeys] = useState(false)
  const counts = useLiveQuery(async () => ({
    owned: (await db.owned.filter((o) => !o.deleted).toArray()).reduce((n, o) => n + o.qty, 0),
    artists: await db.artists.count(),
    scans: await db.scans.count(),
  }), [])

  useEffect(() => { void indexStatus().then(setIdx) }, [])

  const refreshIndex = async () => {
    setBusy(true)
    try { await loadIndex(true); setIdx(await indexStatus()); toast('Card index updated') } catch { toast('Offline') } finally { setBusy(false) }
  }
  const doExport = async () => {
    const blob = new Blob([await exportJson()], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `dex-backup-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
  }
  const doImport = async (f: File | undefined) => {
    if (!f) return
    try { await importJson(await f.text()); toast('Imported') } catch { toast('Bad file') }
  }
  const doSignIn = async () => {
    setBusy(true)
    try { await signIn(email.trim(), pw); toast('Signed in') } catch (e: any) { toast(e.message ?? 'Sign-in failed') } finally { setBusy(false) }
  }
  const wipe = async () => {
    if (!confirm('Delete every scan and owned card on this device? Artists and binder stay.')) return
    await db.owned.clear(); await db.scans.clear()
    toast('Cleared')
  }

  const configured = !!supabase()

  return (
    <div className="screen">
      <TitleBar><Title icon={<Cog size={20} strokeWidth={3} />}>Setup</Title></TitleBar>

      <div className="stack" style={{ gap: 28, maxWidth: 720 }}>
        <section>
          <Title small tone="grey">Scanning</Title>
          <div className="setting">
            <div><div className="setting__label">High value</div><div className="setting__sub">Alert at or above</div></div>
            <Stepper value={s.highValueAud} onChange={(v) => s.set({ highValueAud: v })} min={1} max={5000} step={s.highValueAud >= 50 ? 10 : 1} format={fmtAud} />
          </div>
          <div className="setting">
            <div><div className="setting__label">Page capacity</div><div className="setting__sub">Cards per binder page</div></div>
            <Stepper value={s.pageCapacity} onChange={(v) => s.set({ pageCapacity: v })} min={1} max={36} />
          </div>
          <div className="setting"><div className="setting__label">Sound</div><Switch on={s.sound} onChange={(v) => s.set({ sound: v })} /></div>
          <div className="setting"><div className="setting__label">Haptics</div><Switch on={s.haptics} onChange={(v) => s.set({ haptics: v })} /></div>
        </section>

        <section>
          <Title small tone="grey">Desk</Title>
          <div className="setting">
            <div><div className="setting__label">Open artist page</div><div className="setting__sub">artofpkm.com on new artist</div></div>
            <Switch on={s.autoOpenArtist} onChange={(v) => s.set({ autoOpenArtist: v })} />
          </div>
          <div className="setting">
            <div><div className="setting__label">Open price page</div><div className="setting__sub">TCGplayer on high value</div></div>
            <Switch on={s.autoOpenPrice} onChange={(v) => s.set({ autoOpenPrice: v })} />
          </div>
        </section>

        <section>
          <Title small tone="grey" icon={configured ? <Cloud size={14} /> : <CloudOff size={14} />}>Cloud</Title>
          {!configured && (
            <div className="setting" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
              <div className="setting__sub">Paste the Supabase project URL and anon key to sync phone and desk.</div>
              <input className="input" placeholder="https://xxxx.supabase.co" value={s.supabaseUrl} onChange={(e) => s.set({ supabaseUrl: e.target.value.trim() })} />
              <input className="input" placeholder="anon key" type={showKeys ? 'text' : 'password'} value={s.supabaseKey} onChange={(e) => s.set({ supabaseKey: e.target.value.trim() })} onFocus={() => setShowKeys(true)} />
            </div>
          )}
          {configured && !auth.session && (
            <div className="setting" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
              <input className="input" placeholder="Email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              <input className="input" placeholder="Password" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />
              <button className="btn btn--accent" onClick={doSignIn} disabled={busy || !email || pw.length < 6}>Sign in</button>
              <div className="setting__sub">First sign-in creates the account.</div>
            </div>
          )}
          {auth.session && (
            <>
              <div className="setting">
                <div><div className="setting__label">{auth.session.user.email}</div><div className="setting__sub">{auth.error ? auth.error : auth.lastSync ? `Synced ${new Date(auth.lastSync).toLocaleTimeString()}` : 'Not synced yet'}</div></div>
                <div className="row">
                  <button className="iconbtn" onClick={() => syncNow()} disabled={auth.syncing}><RefreshCw size={18} className={auth.syncing ? 'spin' : ''} /></button>
                  <button className="iconbtn iconbtn--ghost" onClick={() => signOut()}><LogOut size={18} /></button>
                </div>
              </div>
            </>
          )}
          {configured && (
            <div className="setting">
              <div className="setting__sub">Project</div>
              <button className="btn btn--sm btn--ghost" onClick={() => s.set({ supabaseUrl: '', supabaseKey: '' })}>Change</button>
            </div>
          )}
        </section>

        <section>
          <Title small tone="grey">Data</Title>
          <div className="setting">
            <div><div className="setting__label">Card index</div><div className="setting__sub">{idx ? `${idx.count.toLocaleString()} cards · ${new Date(idx.at).toLocaleDateString()}` : 'Not downloaded'}</div></div>
            <button className="iconbtn" onClick={refreshIndex} disabled={busy}><RefreshCw size={18} className={busy ? 'spin' : ''} /></button>
          </div>
          <div className="setting">
            <div><div className="setting__label">Backup</div><div className="setting__sub">{counts ? `${counts.owned} cards · ${counts.artists} artists · ${counts.scans} scans` : ''}</div></div>
            <div className="row">
              <button className="iconbtn" onClick={doExport} aria-label="Export"><Download size={18} /></button>
              <label className="iconbtn" aria-label="Import"><Upload size={18} /><input type="file" accept="application/json" hidden onChange={(e) => doImport(e.target.files?.[0])} /></label>
            </div>
          </div>
          <div className="setting">
            <div><div className="setting__label">Clear cards</div><div className="setting__sub">Keeps artists and binder</div></div>
            <button className="iconbtn iconbtn--danger" onClick={wipe}><Trash2 size={18} /></button>
          </div>
        </section>

        <div className="muted" style={{ fontSize: 'var(--fs-xs)', textAlign: 'center' }}>Dex {__APP_VERSION__} · prices TCGplayer / Cardmarket via TCGdex</div>
      </div>
    </div>
  )
}
