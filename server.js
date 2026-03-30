const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http');
const nodemailer = require('nodemailer');
const path = require('path');
const cron = require('node-cron');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS watchlist (
      id BIGINT PRIMARY KEY,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('Database ready');
}

async function loadWatchlist() {
  const result = await pool.query('SELECT data FROM watchlist ORDER BY created_at ASC');
  return result.rows.map(r => r.data);
}

async function saveItem(item) {
  await pool.query(
    'INSERT INTO watchlist (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = $2',
    [item.id, JSON.stringify(item)]
  );
}

async function removeItem(id) {
  await pool.query('DELETE FROM watchlist WHERE id = $1', [id]);
}

async function updateItem(id, updates) {
  const result = await pool.query('SELECT data FROM watchlist WHERE id = $1', [id]);
  if (!result.rows.length) return null;
  const updated = { ...result.rows[0].data, ...updates };
  await pool.query('UPDATE watchlist SET data = $1 WHERE id = $2', [JSON.stringify(updated), id]);
  return updated;
}

function fetchUrl(urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    const lib = urlStr.startsWith('https') ? https : http;
    const req = lib.get(urlStr, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        ...options.headers
      },
      timeout: 15000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, options).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timed out')); });
  });
}

function postRequest(hostname, pathStr, body, contentType = 'application/json') {
  return new Promise((resolve, reject) => {
    const postData = typeof body === 'string' ? body : JSON.stringify(body);
    const req = https.request({
      hostname, path: pathStr, method: 'POST',
      headers: { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(postData) },
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Bad JSON response')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.write(postData);
    req.end();
  });
}

function serpGet(params) {
  const qs = new URLSearchParams(params).toString();
  return new Promise((resolve, reject) => {
    https.get(`https://serpapi.com/search?${qs}`, {
      headers: { 'User-Agent': 'Node.js' },
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Bad JSON from SerpAPI')); }
      });
    }).on('error', reject);
  });
}

async function uploadToImgBB(base64) {
  const key = process.env.IMGBB_KEY;
  if (!key) throw new Error('IMGBB_KEY not set');
  const body = `key=${encodeURIComponent(key)}&image=${encodeURIComponent(base64)}`;
  const result = await postRequest('api.imgbb.com', '/1/upload', body, 'application/x-www-form-urlencoded');
  if (!result.success) throw new Error('ImgBB upload failed');
  return result.data.url;
}

function extractMeta(html, property) {
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${property}["']`, 'i'),
    new RegExp(`<meta[^>]+name=["']${property}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${property}["']`, 'i'),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) return m[1];
  }
  return null;
}

async function getImageFromUrl(url) {
  const html = await fetchUrl(url);
  return extractMeta(html, 'og:image') || extractMeta(html, 'twitter:image') || null;
}

async function runLensSearch(imageUrl, apiKey) {
  const data = await serpGet({ api_key: apiKey, engine: 'google_lens', url: imageUrl, country: 'us' });
  return (data.visual_matches || []).slice(0, 16).map(m => ({
    title: m.title || 'Unknown item',
    price: m.price || null,
    source: m.source || null,
    link: m.link || null,
    thumbnail: m.thumbnail || null,
  }));
}

async function runShoppingSearch(query, apiKey) {
  const data = await serpGet({ api_key: apiKey, engine: 'google_shopping', q: query, country: 'us', num: 10 });
  return (data.shopping_results || []).slice(0, 10).map(r => ({
    title: r.title, price: r.price, source: r.source, link: r.link, thumbnail: r.thumbnail,
  }));
}

function parsePrice(str) {
  if (!str) return null;
  const n = parseFloat(String(str).replace(/[^0-9.]/g, ''));
  return isNaN(n) ? null : n;
}

app.post('/api/search', async (req, res) => {
  const { imageBase64, url } = req.body;
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) return res.status(400).json({ error: 'SERPAPI_KEY not set.' });

  try {
    let imageUrl = null;
    if (imageBase64) {
      imageUrl = await uploadToImgBB(imageBase64);
    } else if (url) {
      imageUrl = await getImageFromUrl(url);
      if (!imageUrl) return res.status(422).json({ error: 'Could not extract image from that URL. Try uploading a photo directly.' });
    } else {
      return res.status(400).json({ error: 'Please provide an image or URL.' });
    }

    const visualResults = await runLensSearch(imageUrl, apiKey);
    let shoppingResults = [];
    const topTitle = visualResults.find(r => r.title && r.title !== 'Unknown item')?.title;
    if (topTitle) {
      try { shoppingResults = await runShoppingSearch(topTitle, apiKey); } catch (e) {}
    }

    const allResults = [...shoppingResults];
    for (const v of visualResults) {
      if (!allResults.find(r => r.source === v.source)) allResults.push(v);
    }

    const prices = allResults.map(r => parsePrice(r.price)).filter(Boolean);
    const lowestPrice = prices.length ? Math.min(...prices) : null;

    res.json({ results: allResults.slice(0, 20), sourceImage: imageUrl, lowestPrice, searchQuery: topTitle });
  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/watchlist', async (req, res) => {
  try { res.json(await loadWatchlist()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/watchlist', async (req, res) => {
  try {
    const now = new Date().toISOString();
    const item = {
      ...req.body,
      id: Date.now(),
      addedAt: now,
      priceHistory: req.body.savedPrice ? [{ date: now, price: parseFloat(req.body.savedPrice) }] : [],
    };
    await saveItem(item);
    res.json(item);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/watchlist/:id', async (req, res) => {
  try { await removeItem(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/watchlist/:id', async (req, res) => {
  try {
    const updated = await updateItem(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function checkPrices(urgentOnly = false) {
  const apiKey = process.env.SERPAPI_KEY;
  const alertEmail = process.env.ALERT_EMAIL;
  if (!apiKey || !alertEmail) return;

  const list = await loadWatchlist();
  const anyDrops = [], saleDrops = [], urgentDrops = [];

  for (const item of list) {
    if (!item.searchQuery && !item.name) continue;
    try {
      const results = await runShoppingSearch(item.searchQuery || item.name, apiKey);
      let relevantResults = results;
      if (item.retailer) {
        const matched = results.filter(r => r.source && r.source.toLowerCase().includes(item.retailer.toLowerCase()));
        if (matched.length) relevantResults = matched;
      }
      const prices = relevantResults.map(r => parsePrice(r.price)).filter(p => p && p > 5);
      if (!prices.length) continue;

      const lowestPrice = Math.min(...prices);
      const baselinePrice = item.savedPrice || item.currentPrice;
      if (!baselinePrice) continue;
      if (lowestPrice > baselinePrice * 3 || lowestPrice < baselinePrice * 0.1) continue;

      const priceHistory = [...(item.priceHistory || []), { date: new Date().toISOString(), price: lowestPrice }];
      await updateItem(String(item.id), { currentPrice: lowestPrice, priceHistory });

      const dropAmount = baselinePrice - lowestPrice;
      const dropPercent = (dropAmount / baselinePrice) * 100;
      const alertItem = { ...item, lowestPrice, dropPercent: Math.round(dropPercent), dropAmount: Math.round(dropAmount) };

      if (item.targetPrice && lowestPrice <= item.targetPrice) {
        urgentDrops.push({ ...alertItem, hitTarget: true });
      } else if (dropPercent >= 30) {
        urgentDrops.push(alertItem);
      } else if (dropPercent >= 10) {
        saleDrops.push(alertItem);
      } else if (dropAmount > 0) {
        anyDrops.push(alertItem);
      }
    } catch (e) { console.error('Price check error:', e.message); }
  }

  if (urgentDrops.length) await sendAlertEmail(alertEmail, urgentDrops, 'urgent');
  if (!urgentOnly) {
    if (saleDrops.length) await sendAlertEmail(alertEmail, saleDrops, 'sale');
    if (anyDrops.length) await sendAlertEmail(alertEmail, anyDrops, 'any');
  }
}

async function sendAlertEmail(to, items, type) {
  const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
  const subjects = {
    urgent: `🚨 Urgent — ${items.length} item${items.length > 1 ? 's' : ''} dropped 30%+`,
    sale: `🏷️ Sale alert — ${items.length} item${items.length > 1 ? 's' : ''} on sale`,
    any: `📉 Price drop — ${items.length} item${items.length > 1 ? 's' : ''} decreased`,
  };
  const colors = { urgent: '#9b2335', sale: '#1a4480', any: '#2d6a4f' };
  const color = colors[type];
  await transporter.sendMail({
    from: process.env.SMTP_USER, to, subject: subjects[type],
    html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto">
      <h2 style="color:${color}">${subjects[type]}</h2>
      ${items.map(item => `
        <div style="border:1px solid #eee;border-radius:10px;padding:16px;margin:12px 0;display:flex;gap:16px">
          ${item.imageUrl ? `<img src="${item.imageUrl}" style="width:80px;height:80px;object-fit:cover;border-radius:6px;flex-shrink:0">` : ''}
          <div>
            <strong>${item.name}</strong><br>
            ${item.hitTarget ? `<span style="color:${color};font-weight:500">Hit your target price!</span><br>` : ''}
            <span style="color:${color};font-size:18px;font-weight:500">$${item.lowestPrice}</span>
            ${item.savedPrice ? `&nbsp;<span style="color:#999;text-decoration:line-through">$${item.savedPrice}</span>` : ''}
            ${item.dropPercent ? `&nbsp;<span style="background:${color};color:white;padding:2px 8px;border-radius:4px;font-size:12px">-${item.dropPercent}%</span>` : ''}<br>
            ${item.productUrl ? `<a href="${item.productUrl}" style="color:${color}">View item →</a>` : ''}
          </div>
        </div>`).join('')}
      <p style="color:#999;font-size:12px;margin-top:24px">Your Fashion Tracker</p>
    </div>`
  });
}

cron.schedule('0 */12 * * *', () => checkPrices(false));
cron.schedule('0 * * * *', () => checkPrices(true));
app.post('/api/check-prices', async (req, res) => { await checkPrices(false); res.json({ ok: true }); });
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3001;
initDB().then(() => app.listen(PORT, () => console.log(`Server running on port ${PORT}`)))
  .catch(err => { console.error('DB init failed:', err); process.exit(1); });
