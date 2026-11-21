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
}

export interface IndexEntry {
  id: string
  n: string        // normalised collector number
  name: string
  set: string      // set id
  total: number    // official card count of the set
  img: string | null // image base URL (append /low.webp)
}

export interface SetInfo {
  id: string
  name: string
  total: number
  totalAll: number
}

export interface Meta<T = unknown> {
  key: string
  value: T
  at: number
}

export const artistKey = (name: string) =>
  name.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[’'`]/g, '')
