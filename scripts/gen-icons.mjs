// Generates PWA icons from an inline SVG. Run: npm run icons
// Motif: a card held by a coiled band — "Bind".
import sharp from 'sharp'
import { mkdirSync } from 'node:fs'

const icon = (maskable) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0E2A23"/><stop offset="1" stop-color="#071411"/>
    </linearGradient>
    <linearGradient id="a" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2BE8B5"/><stop offset="1" stop-color="#0FA982"/>
    </linearGradient>
    <clipPath id="card"><rect x="158" y="86" width="196" height="280" rx="22"/></clipPath>
  </defs>
  <rect width="512" height="512" rx="${maskable ? 0 : 112}" fill="url(#g)"/>
  <g transform="translate(256 256) scale(${maskable ? 0.72 : 0.9}) translate(-256 -256)">
    <!-- card -->
    <rect x="158" y="86" width="196" height="280" rx="22" fill="#0B1B17" stroke="url(#a)" stroke-width="18"/>
    <rect x="186" y="118" width="140" height="96" rx="12" fill="url(#a)" opacity="0.35"/>
    <!-- band wrapping the card: back half dim, front half bright -->
    <path d="M118 262 C 118 214, 394 214, 394 262" fill="none" stroke="#0FA982" stroke-width="34" stroke-linecap="round" opacity="0.35"/>
    <path d="M118 262 C 118 310, 394 310, 394 262" fill="none" stroke="url(#a)" stroke-width="34" stroke-linecap="round"/>
    <rect x="186" y="300" width="96" height="18" rx="9" fill="#19D3A2" opacity="0.55"/>
  </g>
</svg>`

mkdirSync('public/icons', { recursive: true })
await sharp(Buffer.from(icon(false))).resize(192, 192).png().toFile('public/icons/icon-192.png')
await sharp(Buffer.from(icon(false))).resize(512, 512).png().toFile('public/icons/icon-512.png')
await sharp(Buffer.from(icon(true))).resize(512, 512).png().toFile('public/icons/icon-maskable-512.png')
await sharp(Buffer.from(icon(false))).resize(180, 180).png().toFile('public/icons/apple-touch-icon.png')
console.log('icons written')
