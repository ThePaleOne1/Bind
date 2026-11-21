import { db, uuid } from '../data/db'
import { artistKey, type Artist, type ArtistStatus, type Bucket, type CardRecord, type OwnedCard, type ScanEvent, type ScanMode, type Finish } from '../data/types'
import { getRates, toAud } from '../utils/price'
import { useSettings } from './settings'
import { defaultFinish, priceFor } from '../data/finish'

export async function classifyArtist(card: CardRecord): Promise<{ artist: Artist | null; status: ArtistStatus }> {
  if (!card.illustrator) return { artist: null, status: 'unknown' }
  const key = artistKey(card.illustrator)
  let artist = await db.artists.get(key)
  if (!artist) {
    artist = { key, name: card.illustrator, status: 'unknown', updatedAt: Date.now(), dirty: 1 }
    await db.artists.put(artist)
  }
  return { artist, status: artist.status }
}

export async function cardValueAud(card: CardRecord, finish?: Finish | null) {
  const rates = await getRates()
  const p = priceFor(card, finish ?? undefined)
  return toAud(p.usd, p.eur, rates)
}

/** Apply a scan (add or remove) to the owned table and log the event. */
export async function applyScan(card: CardRecord, mode: ScanMode, finishIn?: Finish | null): Promise<ScanEvent> {
  const { artist, status } = await classifyArtist(card)
  const finish: Finish = finishIn ?? defaultFinish(card)
  const value = await cardValueAud(card, finish)
  const highValue = value != null && value >= useSettings.getState().highValueAud
  const now = Date.now()
  let ownedId: string | null = null

  await db.transaction('rw', db.owned, async () => {
    const existing = (await db.owned.where('cardId').equals(card.id).toArray()).filter((o) => !o.deleted)
    const sameFinish = existing.filter((o) => (o.finish ?? 'normal') === finish)
    if (mode === 'add') {
      if (sameFinish[0]) {
        ownedId = sameFinish[0].id
        await db.owned.update(ownedId, { qty: sameFinish[0].qty + 1, updatedAt: now, dirty: 1 })
      } else {
        const bucket: Bucket = status === 'collecting' ? 'collection' : 'bulk'
        const o: OwnedCard = { id: uuid(), cardId: card.id, bucket, qty: 1, finish, addedAt: now, updatedAt: now, dirty: 1 }
        ownedId = o.id
        await db.owned.put(o)
      }
    } else if (existing[0]) {
      // remove the matching finish if we have it, bulk before collection
      const pool = sameFinish.length ? sameFinish : existing
      const target = pool.find((o) => o.bucket === 'bulk') ?? pool[0]
      ownedId = target.id
      if (target.qty > 1) await db.owned.update(target.id, { qty: target.qty - 1, updatedAt: now, dirty: 1 })
      else await db.owned.update(target.id, { deleted: 1, updatedAt: now, dirty: 1 })
    }
  })

  const ev: ScanEvent = {
    at: now,
    cardId: card.id,
    cardName: card.name,
    image: card.image ?? null,
    action: mode,
    valueAud: value,
    artist: card.illustrator ?? null,
    artistKey: artist?.key ?? null,
    artistStatus: status,
    highValue,
    tcgplayerId: card.tcgplayerId ?? null,
    finish,
    ownedId,
  }
  ev.id = (await db.scans.add(ev)) as number
  return ev
}

/**
 * Re-label ONE copy (the one just scanned) as a different finish: split it off the row
 * when the row holds several, merging into a row of that finish if there is one.
 * Returns the id of the row that copy now lives in.
 */
export async function setFinishOne(ownedId: string, finish: Finish): Promise<string | null> {
  const now = Date.now()
  let target: string | null = null
  await db.transaction('rw', db.owned, async () => {
    const o = await db.owned.get(ownedId)
    if (!o || o.deleted) return
    if ((o.finish ?? 'normal') === finish) { target = o.id; return }
    const twin = (await db.owned.where('cardId').equals(o.cardId).toArray()).find((x) => x.id !== o.id && !x.deleted && (x.finish ?? 'normal') === finish && x.bucket === o.bucket)
    if (o.qty > 1) {
      await db.owned.update(o.id, { qty: o.qty - 1, updatedAt: now, dirty: 1 })
      if (twin) { await db.owned.update(twin.id, { qty: twin.qty + 1, updatedAt: now, dirty: 1 }); target = twin.id }
      else { const n: OwnedCard = { id: uuid(), cardId: o.cardId, bucket: o.bucket, qty: 1, finish, addedAt: now, updatedAt: now, dirty: 1 }; await db.owned.put(n); target = n.id }
    } else if (twin) {
      await db.owned.update(twin.id, { qty: twin.qty + 1, updatedAt: now, dirty: 1 })
      await db.owned.update(o.id, { deleted: 1, updatedAt: now, dirty: 1 })
      target = twin.id
    } else {
      await db.owned.update(o.id, { finish, updatedAt: now, dirty: 1 })
      target = o.id
    }
  })
  return target
}

/** Change the finish of a whole owned row; merges into an existing row of that finish for the same card. */
export async function setFinish(ownedId: string, finish: Finish) {
  const now = Date.now()
  await db.transaction('rw', db.owned, async () => {
    const o = await db.owned.get(ownedId)
    if (!o || o.deleted) return
    const twin = (await db.owned.where('cardId').equals(o.cardId).toArray()).find((x) => x.id !== o.id && !x.deleted && (x.finish ?? 'normal') === finish && x.bucket === o.bucket)
    if (twin) {
      await db.owned.update(twin.id, { qty: twin.qty + o.qty, updatedAt: now, dirty: 1 })
      await db.owned.update(o.id, { deleted: 1, updatedAt: now, dirty: 1 })
    } else {
      await db.owned.update(o.id, { finish, updatedAt: now, dirty: 1 })
    }
  })
}

export async function setBucket(ownedId: string, bucket: Bucket) {
  await db.owned.update(ownedId, { bucket, updatedAt: Date.now(), dirty: 1 })
}
export async function setQty(ownedId: string, qty: number) {
  if (qty <= 0) await db.owned.update(ownedId, { deleted: 1, updatedAt: Date.now(), dirty: 1 })
  else await db.owned.update(ownedId, { qty, updatedAt: Date.now(), dirty: 1 })
}

export async function setArtistStatus(key: string, status: ArtistStatus, extra: Partial<Artist> = {}) {
  const a = await db.artists.get(key)
  if (!a) return
  const patch: Partial<Artist> = { ...extra, status, updatedAt: Date.now(), dirty: 1 }
  if (status !== 'collecting' && a.binderPage) {
    await db.binderPages.update(a.binderPage, { artistKey: null, updatedAt: Date.now(), dirty: 1 })
    patch.binderPage = null
  }
  await db.artists.update(key, patch)
  // Cards of a newly-collected artist graduate from bulk to collection
  if (status === 'collecting') {
    const cards = await db.cards.where('illustrator').equals(a.name).primaryKeys()
    const owned = await db.owned.where('cardId').anyOf(cards as string[]).toArray()
    for (const o of owned) if (o.bucket === 'bulk' && !o.deleted) await setBucket(o.id, 'collection')
  }
}

export async function updateArtist(key: string, patch: Partial<Artist>) {
  await db.artists.update(key, { ...patch, updatedAt: Date.now(), dirty: 1 })
}

export async function upsertArtistByName(name: string, status: ArtistStatus) {
  const key = artistKey(name)
  const existing = await db.artists.get(key)
  if (existing) { await setArtistStatus(key, status); return existing }
  const a: Artist = { key, name: name.trim(), status, updatedAt: Date.now(), dirty: 1 }
  await db.artists.put(a)
  return a
}

/** Put an artist on a binder page (or clear the page). Keeps artist.binderPage in step. */
export async function assignPage(page: number, key: string | null) {
  const now = Date.now()
  await db.transaction('rw', db.binderPages, db.artists, async () => {
    const current = await db.binderPages.get(page)
    if (current?.artistKey) await db.artists.update(current.artistKey, { binderPage: null, updatedAt: now, dirty: 1 })
    if (key) {
      const a = await db.artists.get(key)
      if (a?.binderPage && a.binderPage !== page) {
        await db.binderPages.update(a.binderPage, { artistKey: null, updatedAt: now, dirty: 1 })
      }
      await db.artists.update(key, { binderPage: page, status: 'collecting', updatedAt: now, dirty: 1 })
    }
    await db.binderPages.put({ page, artistKey: key, updatedAt: now, dirty: 1 })
  })
}

export async function exportJson() {
  const [artists, binderPages, owned, cards, scans] = await Promise.all([
    db.artists.toArray(), db.binderPages.toArray(), db.owned.toArray(), db.cards.toArray(), db.scans.toArray(),
  ])
  return JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), artists, binderPages, owned, cards, scans }, null, 1)
}

export async function importJson(text: string) {
  const j = JSON.parse(text)
  await db.transaction('rw', db.artists, db.binderPages, db.owned, db.cards, db.scans, async () => {
    if (j.artists) await db.artists.bulkPut(j.artists)
    if (j.binderPages) await db.binderPages.bulkPut(j.binderPages)
    if (j.owned) await db.owned.bulkPut(j.owned)
    if (j.cards) await db.cards.bulkPut(j.cards)
    if (j.scans) await db.scans.bulkPut(j.scans.map((s: ScanEvent) => ({ ...s, id: undefined })))
  })
}
