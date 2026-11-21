import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ScanMode } from '../data/types'

export interface Settings {
  highValueAud: number
  pageCapacity: number
  sound: boolean
  haptics: boolean
  autoOpenArtist: boolean
  autoOpenPrice: boolean
  supabaseUrl: string
  supabaseKey: string
  scanMode: ScanMode
  set: (p: Partial<Settings>) => void
}

export const useSettings = create<Settings>()(
  persist(
    (set) => ({
      highValueAud: 15,
      pageCapacity: 9,
      sound: true,
      haptics: true,
      autoOpenArtist: true,
      autoOpenPrice: true,
      supabaseUrl: '',
      supabaseKey: '',
      scanMode: 'add',
      set: (p) => set(p),
    }),
    { name: 'dex-settings', partialize: (s) => Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'set')) as any },
  ),
)

export const isDesktop = () => window.matchMedia('(min-width: 960px)').matches
