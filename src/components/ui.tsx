import { motion, AnimatePresence } from 'framer-motion'
import { useEffect, useState, type ReactNode } from 'react'
import { create } from 'zustand'
import type { ArtistStatus, Finish } from '../data/types'
import { finishTag, rarityTag } from '../data/finish'

/* ---------- Title block ---------- */
export function Title({
  children, count, tone = 'accent', small, icon,
}: { children: ReactNode; count?: number; tone?: 'accent' | 'grey' | 'new' | 'value' | 'danger'; small?: boolean; icon?: ReactNode }) {
  return (
    <h1 className={`title ${small ? 'title--sm' : ''} ${tone !== 'accent' ? `title--${tone}` : ''}`} style={{ margin: 0 }}>
      {icon}
      <span>{children}</span>
      {count != null && <span className="title__count">{count}</span>}
    </h1>
  )
}

export function TitleBar({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="titlebar">
      {children}
      {actions && <div className="titlebar__actions">{actions}</div>}
    </div>
  )
}

/* ---------- Segmented control ---------- */
export function Segmented<T extends string>({
  value, onChange, options,
}: { value: T; onChange: (v: T) => void; options: { value: T; label: string; count?: number; icon?: ReactNode }[] }) {
  return (
    <div className="seg" role="tablist">
      {options.map((o) => {
        const on = o.value === value
        return (
          <button key={o.value} role="tab" aria-selected={on} className={`seg__btn ${on ? 'seg__btn--on' : ''}`} onClick={() => onChange(o.value)}>
            {on && <motion.span layoutId="seg-thumb" className="seg__thumb" transition={{ type: 'spring', stiffness: 500, damping: 38 }} />}
            <span style={{ position: 'relative', zIndex: 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {o.icon}{o.label}{o.count != null && <span className="seg__count">{o.count}</span>}
            </span>
          </button>
        )
      })}
    </div>
  )
}

/* ---------- Chip for artist status ---------- */
export const STATUS_WORD: Record<ArtistStatus, string> = { collecting: 'Collecting', 'not-collecting': 'Not collecting', unknown: 'New artist' }
export function StatusChip({ status }: { status: ArtistStatus }) {
  return <span className={`chip chip--${status}`}>{STATUS_WORD[status]}</span>
}

/* ---------- Card image with shimmer ---------- */
/**
 * Card art. `quality="high"` is progressive: the small image (a few KB, usually
 * already cached) shows at once and the large one fades in over it when it
 * arrives, so a result card never sits on a shimmer waiting for a big download.
 * `eager` asks the browser to fetch it ahead of other work (scan result overlay).
 */
export function CardImage({ src, alt, className, style, quality = 'low', eager = false, onClick }: {
  src: string | null | undefined; alt?: string; className?: string; style?: React.CSSProperties; quality?: 'low' | 'high'; eager?: boolean; onClick?: () => void
}) {
  const [loaded, setLoaded] = useState(false)
  const [hiLoaded, setHiLoaded] = useState(false)
  const low = src ? `${src}/low.webp` : null
  const high = src && quality === 'high' ? `${src}/high.webp` : null
  useEffect(() => { setLoaded(false); setHiLoaded(false) }, [src])
  // Slow data: after a while show whatever has arrived instead of a shimmer forever.
  useEffect(() => { if (loaded || !src) return; const t = setTimeout(() => setLoaded(true), 6000); return () => clearTimeout(t) }, [loaded, src])
  const imgProps = { loading: eager ? ('eager' as const) : ('lazy' as const), decoding: 'async' as const, draggable: false, ...(eager ? ({ fetchpriority: 'high' } as Record<string, string>) : {}) }
  if (!src) {
    return (
      <div className={`cardimg cardimg--none ${className ?? ''}`} style={style} onClick={onClick}>
        <span>{alt ?? 'No art'}</span>
      </div>
    )
  }
  return (
    <div className={`cardimg ${className ?? ''}`} style={style} onClick={onClick}>
      {!loaded && <div className="cardimg__shimmer" />}
      {low && <img src={low} alt={alt ?? ''} {...imgProps} className={loaded ? 'loaded' : ''} onLoad={() => setLoaded(true)} onError={() => setLoaded(true)} />}
      {high && <img src={high} alt="" {...imgProps} className={`cardimg__hi ${hiLoaded ? 'loaded' : ''}`} onLoad={() => setHiLoaded(true)} aria-hidden />}
    </div>
  )
}

/** Finish and rarity tags in a tile's corner. */
export function TileTags({ finish, rarity, lang }: { finish?: Finish | null; rarity?: string | null; lang?: 'ja' | null }) {
  const f = finishTag(finish), r = rarityTag(rarity)
  if (!f && !r && !lang) return null
  return (
    <span className="tile__tags">
      {lang === 'ja' && <span className="tile__tag tile__tag--jp">JP</span>}
      {f && <span className="tile__tag tile__tag--finish">{f}</span>}
      {r && <span className="tile__tag">{r}</span>}
    </span>
  )
}

/** Warm the browser cache for a card's art before it is shown. */
export function prefetchCardImage(src: string | null | undefined, quality: 'low' | 'high' = 'low') {
  if (!src) return
  const i = new Image()
  ;(i as any).fetchPriority = 'high'
  i.src = `${src}/${quality}.webp`
}

/* ---------- Bottom sheet ---------- */
export function Sheet({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  const desktop = typeof window !== 'undefined' && window.matchMedia('(min-width: 960px)').matches
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div className="sheet-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
          <motion.div
            className="sheet"
            initial={{ y: desktop ? 24 : '100%', opacity: desktop ? 0 : 0.6, scale: desktop ? 0.98 : 1 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: desktop ? 24 : '100%', opacity: desktop ? 0 : 0.6 }}
            transition={{ type: 'spring', stiffness: 420, damping: 40 }}
            drag={desktop ? false : 'y'}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.6 }}
            onDragEnd={(_, info) => { if (info.offset.y > 120 || info.velocity.y > 600) onClose() }}
          >
            <div className="sheet__grip" />
            <div className="sheet__body">{children}</div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}

/* ---------- Toasts ---------- */
interface ToastState { items: { id: number; text: string }[]; push: (text: string) => void }
export const useToast = create<ToastState>((set) => ({
  items: [],
  push: (text) => {
    const id = Date.now() + Math.random()
    set((s) => ({ items: [...s.items, { id, text }] }))
    setTimeout(() => set((s) => ({ items: s.items.filter((t) => t.id !== id) })), 2400)
  },
}))
export const toast = (text: string) => useToast.getState().push(text)

export function Toasts() {
  const items = useToast((s) => s.items)
  return (
    <div className="toasts">
      <AnimatePresence>
        {items.map((t) => (
          <motion.div key={t.id} className="toast" initial={{ y: 20, opacity: 0, scale: 0.95 }} animate={{ y: 0, opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }}>
            {t.text}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}

/* ---------- Switch & Stepper ---------- */
export function Switch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return <button className={`switch ${on ? 'on' : ''}`} role="switch" aria-checked={on} onClick={() => onChange(!on)} />
}
export function Stepper({ value, onChange, min = 0, max = 999, step = 1, format }: {
  value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; format?: (v: number) => string
}) {
  return (
    <div className="stepper">
      <button onClick={() => onChange(Math.max(min, value - step))}>−</button>
      <span>{format ? format(value) : value}</span>
      <button onClick={() => onChange(Math.min(max, value + step))}>+</button>
    </div>
  )
}

export function Fav({ rank }: { rank?: number | null }) {
  // 1 = best. Four dots, filled from the left.
  const filled = rank ? Math.max(0, 5 - rank) : 0
  return <span className="fav">{[0, 1, 2, 3].map((i) => <i key={i} className={i < filled ? 'on' : ''} />)}</span>
}
