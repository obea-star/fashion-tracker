const express = require('express');
const cors = require('cors');
const axios = require('axios');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const DATA_FILE = path.join(__dirname, 'watchlist.json');

function loadWatchlist() {
  if (!fs.existsSync(DATA_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return []; }
}

function saveWatchlist(list) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2));
}

// --- Search by image (base64) or URL ---
app.post('/api/search', async (req, res) => {
  const { imageBase64, url, query } = req.body;
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) return res.status(400).json({ error: 'SERPAPI_KEY not set' });

  try {
    let params = { api_key: apiKey, engine: 'google_lens', country: 'us' };

    if (imageBase64) {
      params.url = `data:image/jpeg;base64,${imageBase64}`;
    } else if (url) {
      params.url = url;
    } else if (query) {
      // Fall back to shopping search
      const r = await axios.get('https://serpapi.com/search', {
        params: { api_key: apiKey, engine: 'google_shopping', q: query, country: 'us', num: 10 }
      });
      const results = (r.data.shopping_results || []).slice(0, 10).map(item => ({
        title: item.title,
        price: item.price,
        source: item.source,
        link: item.link,
        thumbnail: item.thumbnail,
      }));
      return res.json({ results });
    }

    const r = await axios.get('https://serpapi.com/search', { params });
    const visual = r.data.visual_matches || [];
    const results = visual.slice(0, 12).map(item => ({
      title: item.title,
      price: item.price || null,
      source: item.source,
      link: item.link,
      thumbnail: item.thumbnail,
    }));
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Watchlist CRUD ---
app.get('/api/watchlist', (req, res) => res.json(loadWatchlist()));

app.post('/api/watchlist', (req, res) => {
  const list = loadWatchlist();
  const item = { ...req.body, id: Date.now(), addedAt: new Date().toISOString(), priceHistory: [] };
  list.push(item);
  saveWatchlist(list);
  res.json(item);
});

app.delete('/api/watchlist/:id', (req, res) => {
  const list = loadWatchlist().filter(i => String(i.id) !== req.params.id);
  saveWatchlist(list);
  res.json({ ok: true });
});

app.put('/api/watchlist/:id', (req, res) => {
  const list = loadWatchlist();
  const idx = list.findIndex(i => String(i.id) === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  list[idx] = { ...list[idx], ...req.body };
  saveWatchlist(list);
  res.json(list[idx]);
});

// --- Price check ---
async function checkPrices() {
  const apiKey = process.env.SERPAPI_KEY;
  const alertEmail = process.env.ALERT_EMAIL;
  if (!apiKey || !alertEmail) return;

  const list = loadWatchlist();
  const drops = [];

  for (const item of list) {
    if (!item.productUrl && !item.name) continue;
    try {
      const r = await axios.get('https://serpapi.com/search', {
        params: { api_key: apiKey, engine: 'google_shopping', q: item.name, num: 5 }
      });
      const results = r.data.shopping_results || [];
      if (!results.length) continue;

      // Parse lowest price found
      const prices = results.map(r => {
        const p = parseFloat((r.price || '').replace(/[^0-9.]/g, ''));
        return isNaN(p) ? null : p;
      }).filter(Boolean);

      if (!prices.length) continue;
      const lowestPrice = Math.min(...prices);

      // Record history
      item.priceHistory = item.priceHistory || [];
      item.priceHistory.push({ date: new Date().toISOString(), price: lowestPrice });
      item.currentPrice = lowestPrice;

      if (item.targetPrice && lowestPrice <= item.targetPrice) {
        drops.push({ ...item, lowestPrice });
      }
    } catch (e) {
      console.error('Price check error for', item.name, e.message);
    }
  }

  saveWatchlist(list);

  if (drops.length > 0) {
    await sendAlertEmail(alertEmail, drops);
  }
}

async function sendAlertEmail(to, drops) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });

  const itemList = drops.map(d =>
    `• ${d.name} — now $${d.lowestPrice} (your target: $${d.targetPrice})\n  ${d.productUrl || ''}`
  ).join('\n\n');

  await transporter.sendMail({
    from: process.env.SMTP_USER,
    to,
    subject: `Price drop alert — ${drops.length} item${drops.length > 1 ? 's' : ''} hit your target`,
    text: `Good news! The following items have hit your target price:\n\n${itemList}\n\nHappy shopping!`,
    html: `
      <h2 style="font-family:sans-serif">Price drop alert</h2>
      <p style="font-family:sans-serif">The following items have hit your target price:</p>
      ${drops.map(d => `
        <div style="font-family:sans-serif;border:1px solid #eee;border-radius:8px;padding:16px;margin:12px 0">
          <strong>${d.name}</strong><br>
          Now: <span style="color:green;font-size:1.2em">$${d.lowestPrice}</span> &nbsp; 
          <span style="color:#999">Your target: $${d.targetPrice}</span><br>
          ${d.productUrl ? `<a href="${d.productUrl}">View item</a>` : ''}
        </div>
      `).join('')}
      <p style="font-family:sans-serif;color:#999;font-size:12px">Your Fashion Tracker</p>
    `
  });
}

// Run price check every 12 hours
cron.schedule('0 */12 * * *', () => {
  console.log('Running scheduled price check...');
  checkPrices();
});

// Manual trigger endpoint
app.post('/api/check-prices', async (req, res) => {
  await checkPrices();
  res.json({ ok: true, message: 'Price check complete' });
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Fashion Tracker server running on port ${PORT}`));
