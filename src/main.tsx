import React from 'react'
import ReactDOM from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import App from './App'
import './styles/base.css'
import { toast } from './components/ui'

// Auto-update: when a new build is deployed, swap it in on the next launch
// and tell the user a refresh is pending.
const updateSW = registerSW({
  onNeedRefresh() {
    toast('Update ready — reopening')
    setTimeout(() => updateSW(true), 1200)
  },
  onOfflineReady() { /* cached for offline use */ },
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
