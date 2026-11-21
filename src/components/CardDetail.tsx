import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { ExternalLink, Trash2, Palette, RefreshCw } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { db } from '../data/db'
import type { CardRecord } from '../data/types'
import { artistKey } from '../data/types'
import { getCard, imageUrl, tcgplayerUrl, cardmarketUrl } from '../api/tcgdex'
import { cardValueAud, setBucket, setQty } from '../store/collection'
import { fmtAud } from '../utils/price'
import { useSettings } from '../store/settings'
import { CardImage, Segmented, StatusChip, Stepper, Sheet, toast } from './ui'

export function CardDetailSheet({ cardId, onClose }: { cardId: string | null; onClose: () => void }) {
  return (
    <Sheet open={!!cardId} onClose={onClose}>
      {cardId && <CardDetail cardId={cardId} onClose={onClose} />}
    </Sheet>
  )
}

export function CardDetail({ cardId, onClose }: { cardId: string; onClose?: () => void }) {
  const nav = useNavigate()
  const card = useLiveQuery(() => db.cards.get(cardId), [cardId])
  const owned = useLiveQuery(() => db.owned.where('cardId').equals(cardId).filter((o) => !o.deleted).toArray(), [cardId])
  const artist = useLiveQuery(() => (card?.illustrator ? db.artists.get(artistKey(card.illustrator)) : undefined), [card?.illustrator])
  const [value, setValue] = useState<number | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const threshold = useSettings((s) => s.highValueAud)

  useEffect(() => { if (card) void cardValueAud(card).then(setValue) }, [card?.priceUsd, card?.priceEur])
  useEffect(() => { if (!card) void getCard(cardId).catch(() => toast('Offline')) }, [cardId, card])

  if (!card) return <div className="empty">Loading…</div>
  const o = owned?.[0]
  const hot = value != null && value >= threshold

  const refresh = async () => {
    setRefreshing(true)
    try { await getCard(cardId, { refresh: true }); toast('Prices updated') } catch { toast('Offline') } finally { setRefreshing(false) }
  }

  return (
    <div className="detail">
      <CardImage src={card.image} quality="high" alt={card.name} onClick={() => window.open(imageUrl(card.image, 'high')!, '_blank')} />
      <div className="stack" style={{ gap: 14 }}>
        <div>
          <div className="big">{card.name}</div>
          <div className="muted" style={{ fontWeight: 700 }}>{card.setName} · {card.localId}/{card.setTotal || '?'}</div>
        </div>

        {card.illustrator && (
          <button
            className="row row--between card-panel"
            style={{ width: '100%', textAlign: 'left', padding: '12px 14px' }}
            onClick={() => { onClose?.(); nav(`/artist/${encodeURIComponent(artistKey(card.illustrator!))}`) }}
          >
            <span className="row"><Palette size={18} color="var(--accent)" /> <b>{card.illustrator}</b></span>
            {artist && <StatusChip status={artist.status} />}
          </button>
        )}

        <div className="detail__facts">
          <div className="fact"><div className="label">Value</div><div className="fact__v" style={hot ? { color: 'var(--value)' } : undefined}>{fmtAud(value)}</div></div>
          <div className="fact"><div className="label">Rarity</div><div className="fact__v" style={{ fontSize: 'var(--fs-md)' }}>{card.rarity ?? '—'}</div></div>
          <div className="fact"><div className="label">TCGplayer</div><div className="fact__v">{card.priceUsd ? `US$${card.priceUsd.toFixed(2)}` : '—'}</div></div>
          <div className="fact"><div className="label">Cardmarket</div><div className="fact__v">{card.priceEur ? `€${card.priceEur.toFixed(2)}` : '—'}</div></div>
        </div>

        {o ? (
          <>
            <div className="row row--between">
              <Segmented value={o.bucket} onChange={(b) => setBucket(o.id, b)} options={[{ value: 'collection', label: 'Collection' }, { value: 'bulk', label: 'Bulk' }]} />
              <Stepper value={o.qty} onChange={(q) => setQty(o.id, q)} min={0} />
            </div>
            <button className="btn btn--ghost" onClick={async () => { await setQty(o.id, 0); toast('Removed'); onClose?.() }}>
              <Trash2 size={18} /> Remove
            </button>
          </>
        ) : (
          <div className="chip chip--outline" style={{ alignSelf: 'flex-start' }}>Not owned</div>
        )}

        <div className="row" style={{ flexWrap: 'wrap' }}>
          <a className="btn btn--sm" href={tcgplayerUrl(card)} target="_blank" rel="noreferrer"><ExternalLink size={14} /> TCGplayer</a>
          <a className="btn btn--sm" href={cardmarketUrl(card)} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Cardmarket</a>
          <button className="btn btn--sm btn--ghost" onClick={refresh} disabled={refreshing}><RefreshCw size={14} className={refreshing ? 'spin' : ''} /> Prices</button>
        </div>
      </div>
    </div>
  )
}

export function useCardValue(card: CardRecord | undefined) {
  const [v, setV] = useState<number | null>(null)
  useEffect(() => { if (card) void cardValueAud(card).then(setV) }, [card?.priceUsd, card?.priceEur])
  return v
}
