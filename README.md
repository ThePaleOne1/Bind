# Dex — Pokémon card collection, sorted by artist

Installable web app (PWA) that scans cards with the phone camera, sorts the collection by illustrator, tracks the binder page for each artist, shows prices, and pushes live scan events to a desk companion on the PC.

One codebase serves both devices: the phone gets a bottom tab bar, the desktop (≥ 960 px) gets a side rail and the Desk view.

## Develop

```bash
npm install
npm run dev
```

Open http://localhost:5173. The camera only works over HTTPS or on localhost, so on the phone you test against the deployed site.

## Deploy (phone receives updates automatically)

1. Create an empty GitHub repository (public or private) called `dex`, or any name.
2. Push this folder:
   ```bash
   git remote add origin https://github.com/<you>/dex.git
   git push -u origin main
   ```
3. In the repo: **Settings → Pages → Source: GitHub Actions**.
4. Every push to `main` builds and deploys to `https://<you>.github.io/dex/`. The installed app checks for a new version on launch and swaps it in.

Optional: add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` as repository secrets (Settings → Secrets → Actions) so the cloud link is baked in. Otherwise paste them once in **Setup → Cloud** on each device.

## Install as an app

- **Android (Chrome):** open the site → ⋮ → *Add to Home screen* / *Install app*.
- **iPhone (Safari):** Share → *Add to Home Screen*. (Camera works in the installed app on iOS 16.4+.)
- **Windows (Edge or Chrome):** open the site → address-bar *Install* icon (or ⋯ → *Apps → Install*). Pin it to the taskbar from the Start menu. It opens in its own window with the Dex icon.

## Cloud sync + desk link (Supabase, free tier)

1. Create a project at supabase.com.
2. SQL editor → paste `supabase/schema.sql` → run.
3. Project settings → API: copy the project URL and anon key into **Setup → Cloud** on the phone and the PC (or the GitHub secrets above).
4. Sign in with the same email + password on both devices. First sign-in creates the account.

Without Supabase everything still works on one device, and two tabs of the same browser can talk to each other for testing.

## Scanning

Hold a card inside the frame. The app waits until the picture is still (~0.35 s), reads the name band and the bottom band (collector number, illustrator credit) with on-device OCR, matches it against the local TCGdex index (~22 k cards, cached for 7 days), then fetches artist, rarity and prices. Lift the card and the next one is armed automatically.

- Result word: **Collecting** / **Not collecting** / **New artist** / **High value** / **Removed**.
- Cards from collecting artists go to *Collection*; everything else to *Bulk*. Changing an artist to *Collect* moves their bulk cards across.
- **Add / Remove** toggle at the bottom for trades and giveaways.
- Magnifier button: manual search (`umbreon`, `025/198`, `tg23/tg30`).
- Double-tap the camera view to see OCR debug text.

Prices come from TCGplayer (USD) and Cardmarket (EUR) via TCGdex and are shown in AUD using a daily exchange rate. The high-value threshold is in Setup.

## Artists spreadsheet

`src/data/artistsSeed.json` is generated from `Pokemon Artists.xlsx` and seeds a fresh database. To regenerate after editing the spreadsheet:

```bash
python scripts/import_artists.py
```

(If OneDrive refuses to open the file in place, copy it somewhere first and pass the path as an argument.)

## Stack

Vite · React · TypeScript · Dexie (IndexedDB) · Tesseract.js · framer-motion · Supabase · vite-plugin-pwa · GitHub Pages.
