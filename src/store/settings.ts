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
  preview4k: boolean      // 4K preview (only for lenses that cannot take a full-resolution still); default 720p
  askFinish: boolean      // when a card comes in several finishes and the foil read is unsure, ask before adding
  japanese: boolean       // expect Japanese prints: a Japanese card with the right number needs no readable set code
  effects: boolean        // confetti, flash and spring animations on a scan (off = lighter on slow phones)
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
      preview4k: false,
      askFinish: true,
      japanese: false,
      effects: true,
      set: (p) => set(p),
    }),
    { name: 'bind-settings', partialize: (s) => Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'set')) as any },
  ),
)

export const isDesktop = () => window.matchMedia('(min-width: 960px)').matches
