// Generates PWA icons from an inline SVG. Run: npm run icons
import sharp from 'sharp'
import { mkdirSync } from 'node:fs'

const icon = (pad) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0E2A23"/><stop offset="1" stop-color="#071411"/>
    </linearGradient>
    <linearGradient id="a" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2BE8B5"/><stop offset="1" stop-color="#0FA982"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="${pad ? 0 : 112}" fill="url(#g)"/>
  <g transform="translate(256 256) scale(${pad ? 0.72 : 0.86}) translate(-256 -256)">
    <rect x="150" y="76" width="212" height="300" rx="26" fill="none" stroke="url(#a)" stroke-width="30"/>
    <rect x="150" y="76" width="212" height="300" rx="26" fill="#19D3A2" opacity="0.08"/>
    <circle cx="256" cy="226" r="54" fill="url(#a)"/>
    <rect x="196" y="316" width="120" height="22" rx="11" fill="#19D3A2" opacity="0.6"/>
  </g>
</svg>`

mkdirSync('public/icons', { recursive: true })
await sharp(Buffer.from(icon(false))).resize(192, 192).png().toFile('public/icons/icon-192.png')
await sharp(Buffer.from(icon(false))).resize(512, 512).png().toFile('public/icons/icon-512.png')
await sharp(Buffer.from(icon(true))).resize(512, 512).png().toFile('public/icons/icon-maskable-512.png')
await sharp(Buffer.from(icon(false))).resize(180, 180).png().toFile('public/icons/apple-touch-icon.png')
console.log('icons written')
