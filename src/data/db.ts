import Dexie, { type Table } from 'dexie'
import type { Artist, BinderPage, CardRecord, OwnedCard, ScanEvent, Meta } from './types'
import { artistKey } from './types'
import seed from './artistsSeed.json'

export class DexDB extends Dexie {
  artists!: Table<Artist, string>
  binderPages!: Table<BinderPage, number>
  cards!: Table<CardRecord, string>
  owned!: Table<OwnedCard, string>
  scans!: Table<ScanEvent, number>
  meta!: Table<Meta, string>

  constructor() {
    super('bind-cards')
    this.version(1).stores({
      artists: 'key, status, binderPage, dirty',
      binderPages: 'page, artistKey, dirty',
      cards: 'id, name, setId, illustrator',
      owned: 'id, cardId, bucket, addedAt, dirty, deleted',
      scans: '++id, at, cardId',
      meta: 'key',
    })
  }
}

export const db = new DexDB()

export const BINDER_PAGES = 36

export async function seedIfEmpty() {
  const count = await db.artists.count()
  if (count > 0) return
  const now = Date.now()
  const artists: Artist[] = (seed.artists as any[]).map((a) => ({
    key: artistKey(a.name),
    name: a.name,
    status: a.status,
    reason: a.reason ?? null,
    favourite: a.favourite ?? null,
    style: a.style ?? null,
    note: a.note ?? null,
    binderPage: a.binderPage ?? null,
    updatedAt: now,
    dirty: 1,
  }))
  const pages: BinderPage[] = []
  for (let p = 1; p <= BINDER_PAGES; p++) {
    const s = (seed.pages as any[]).find((x) => x.page === p)
    pages.push({ page: p, artistKey: s?.artist ? artistKey(s.artist) : null, updatedAt: now, dirty: 1 })
  }
  await db.transaction('rw', db.artists, db.binderPages, async () => {
    await db.artists.bulkPut(artists)
    await db.binderPages.bulkPut(pages)
  })
}

export async function getMeta<T>(key: string): Promise<Meta<T> | undefined> {
  return (await db.meta.get(key)) as Meta<T> | undefined
}
export async function setMeta<T>(key: string, value: T) {
  await db.meta.put({ key, value, at: Date.now() })
}

export const uuid = (): string =>
  (crypto as any).randomUUID?.() ??
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
