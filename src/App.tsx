import { lazy, Suspense, useEffect } from 'react'
import { HashRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { Nav } from './components/Nav'
import { Toasts } from './components/ui'
import { seedIfEmpty } from './data/db'
import { initAuth } from './sync/supabase'
import { loadIndex } from './api/tcgdex'
import { isDesktop } from './store/settings'

const Scan = lazy(() => import('./screens/Scan'))
const Collection = lazy(() => import('./screens/Collection'))
const Binder = lazy(() => import('./screens/Binder'))
const ArtistDetail = lazy(() => import('./screens/ArtistDetail'))
const Companion = lazy(() => import('./screens/Companion'))
const Settings = lazy(() => import('./screens/Settings'))
const Bench = lazy(() => import('./screens/Bench'))

function Shell() {
  const { pathname } = useLocation()
  useEffect(() => {
    // Keep the body background matching the scan screen for edge-to-edge camera
    document.documentElement.style.background = pathname.startsWith('/scan') ? '#000' : ''
  }, [pathname])
  return (
    <div className="app">
      <main className="app__main">
        <Suspense fallback={<div className="empty" style={{ height: '100%' }}><span className="muted">…</span></div>}>
          <Routes>
            <Route path="/" element={<Navigate to={isDesktop() ? '/companion' : '/scan'} replace />} />
            <Route path="/scan" element={<Scan />} />
            <Route path="/collection" element={<Collection />} />
            <Route path="/binder" element={<Binder />} />
            <Route path="/artist/:key" element={<ArtistDetail />} />
            <Route path="/companion" element={<Companion />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/bench" element={<Bench />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </main>
      <Nav />
      <Toasts />
    </div>
  )
}

export default function App() {
  useEffect(() => {
    void seedIfEmpty()
    void initAuth()
    void loadIndex().catch(() => {})
  }, [])
  return (
    <HashRouter>
      <Shell />
    </HashRouter>
  )
}
