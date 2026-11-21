export type ArtistStatus = 'collecting' | 'not-collecting' | 'unknown'
export type Bucket = 'collection' | 'bulk'
export type ScanMode = 'add' | 'remove'

export interface Artist {
  key: string          // normalised lower-case name, primary key
  name: string         // display name as printed on cards / spreadsheet
  status: ArtistStatus
  reason?: string | null      // why not collecting
  favourite?: number | null   // 1 = top favourite
  style?: string | null
  note?: string | null
  binderPage?: number | null
  updatedAt: number
  dirty?: number              // 1 = needs push to cloud
}

export interface BinderPage {
  page: number
  artistKey: string | null
  updatedAt: number
  dirty?: number
}

/** Print finish of a physical copy. The collector number is the same for all of them. */
export type Finish = 'normal' | 'reverse' | 'holo' | 'first-edition'

export interface CardRecord {
  id: string
  name: string
  localId: string
  setId: string
  setName: string
  setTotal: number
  image?: string | null
  illustrator?: string | null
  rarity?: string | null
  category?: string | null
  lang?: 'ja'
  /** Finishes this card was printed in, from the card database. */
  variants?: { normal: boolean; reverse: boolean; holo: boolean; firstEdition: boolean } | null
  /** Market price per finish, where the database prices them separately. */
  variantPrices?: Partial<Record<Finish, { usd: number | null; eur: number | null }>> | null
  priceUsd?: number | null
  priceEur?: number | null
  tcgplayerId?: number | null
  cardmarketId?: number | null
  pricesUpdatedAt?: number
  fetchedAt: number
}

export interface OwnedCard {
  id: string
  cardId: string
  bucket: Bucket
  qty: number
  finish?: Finish | null
  addedAt: number
  updatedAt: number
  deleted?: number   // soft delete for sync
  dirty?: number
}

export interface ScanEvent {
  id?: number
  at: number
  cardId: string
  cardName: string
  image?: string | null
  action: ScanMode
  valueAud?: number | null
  artist?: string | null
  artistKey?: string | null
  artistStatus: ArtistStatus
  highValue: boolean
  tcgplayerId?: number | null
  finish?: Finish | null
  /** The owned row this scan touched (so the result overlay can flip its finish). */
  ownedId?: string | null
}

export interface IndexEntry {
  /** Card id; Japanese catalogue ids carry a "ja:" prefix (set ids like "neo1" exist in both languages). */
  id: string
  n: string        // normalised collector number
  name: string
  set: string      // set id
  total: number    // official card count of the set
  img: string | null // image base URL (append /low.webp)
  lang?: 'ja'        // Japanese print: the name is in Japanese and cannot be read by the OCR
}

export interface SetInfo {
  id: string
  name: string
  total: number
  totalAll: number
  lang?: 'ja'
}

/** "ja:M2a" → "M2a": the code printed on the card, without the catalogue prefix. */
export const setCode = (setId: string) => setId.replace(/^ja:/, '')

export interface Meta<T = unknown> {
  key: string
  value: T
  at: number
}

export const artistKey = (name: string) =>
  name.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[’'`]/g, '')
