# VKT Playwright Scraper

Automatically scrapes StubHub event pages for listing counts, floor prices, ATP, and section data.

## Setup on Railway

1. Push this folder to a new GitHub repo (e.g. `vkt-playwright`)
2. Go to railway.app → New Project → Deploy from GitHub → select the repo
3. Set environment variables in Railway:
   - `SUPABASE_URL` = your Supabase URL
   - `SUPABASE_KEY` = your Supabase anon key
   - `VKT_API` = https://vkt-volume-api.vercel.app
   - `SCRAPE_DELAY` = 6000 (ms between events)
4. Railway will build and run automatically

## Schedule

To run on a schedule in Railway:
- Go to your service → Settings → Cron Schedule
- Set to `0 */6 * * *` (every 6 hours)

## What it does

1. Fetches all StubHub events from your Supabase database
2. Skips events scraped in the last 20 hours
3. Opens each event page in a headless Chrome browser
4. Extracts: total listings, floor price, ATP, ceiling price
5. Scrapes all sections from the venue map
6. Posts all data to your VKT API
7. Updates event names in the database with clean names from JSON-LD
