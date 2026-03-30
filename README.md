# Fashion Price Tracker — Backend

A personal price tracking server that monitors fashion items and sends email alerts when prices drop.

## Environment Variables (set in Railway)

| Variable | Description |
|----------|-------------|
| `SERPAPI_KEY` | Your SerpAPI key from serpapi.com |
| `ALERT_EMAIL` | Email address to send price drop alerts to |
| `SMTP_USER` | Gmail address used to send alerts |
| `SMTP_PASS` | Gmail app password (not your regular password) |

## How to get a Gmail App Password

1. Go to myaccount.google.com
2. Search "App passwords"
3. Create a new app password for "Mail"
4. Copy the 16-character password — use this as SMTP_PASS

## API Endpoints

- `GET /health` — check server is running
- `POST /api/search` — search for an item by image or query
- `GET /api/watchlist` — get all saved items
- `POST /api/watchlist` — add an item
- `DELETE /api/watchlist/:id` — remove an item
- `POST /api/check-prices` — manually trigger a price check
