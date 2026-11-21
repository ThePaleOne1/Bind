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
  cameraId: string
  hiRes: boolean          // ask the camera for 4K (sharper small print) rather than 1080p (lighter on the phone)
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
      cameraId: '',
      hiRes: true,
      set: (p) => set(p),
    }),
    { name: 'bind-settings', partialize: (s) => Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'set')) as any },
  ),
)

export const isDesktop = () => window.matchMedia('(min-width: 960px)').matches
