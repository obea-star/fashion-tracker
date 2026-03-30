const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

const DATA_FILE = path.join(__dirname, 'watchlist.json');

function loadWatchlist() {
  if (!fs.existsSync(DATA_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return []; }
}

function saveWatchlist(list) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2));
}

// Simple regex-based meta tag extractor — no cheerio needed
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

function fetchUrl(urlStr) {
  return new Promise((resolve, reject) => {
    const lib = urlStr.startsWith('https') ? https : http;
    const req = lib.get(urlStr, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 15000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timed out')); });
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

function serpPost(body) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body);
    const req = https.request({
      hostname: 'serpapi.com',
      path: '/search',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Bad JSON from SerpAPI')); }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function formatMatches(data) {
  return (data.visual_matches || []).slice(0, 16).map(m => ({
    title: m.title || 'Unknown item',
    price: m.price || null,
    source: m.source || null,
    link: m.link || null,
    thumbnail: m.thumbnail || null,
  }));
}

function detectUrlType(url) {
  if (url.includes('pinterest.com') || url.includes('pin.it')) return 'pinterest';
  if (url.includes('instagram.com')) return 'instagram';
  return 'product';
}

async function getImageFromUrl(url) {
  const html = await fetchUrl(url);
  return (
    extractMeta(html, 'og:image') ||
    extractMeta(html, 'twitter:image') ||
    null
  );
}

// Main search endpoint
app.post('/api/search', async (req, res) => {
  const { imageBase64, url } = req.body;
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) return res.status(400).json({ error: 'SERPAPI_KEY not set in Railway variables.' });

  try {
    let results = [];
    let sourceImageUrl = null;

    if (imageBase64) {
      const data = await serpPost({ api_key: apiKey, engine: 'google_lens', image_content: imageBase64, country: 'us' });
      results = formatMatches(data);
    } else if (url) {
      sourceImageUrl = await getImageFromUrl(url);
      if (!sourceImageUrl) {
        return res.status(422).json({ error: 'Could not extract image from that URL. Try uploading a photo directly instead.' });
      }
      const data = await serpGet({ api_key: apiKey, engine: 'google_lens', url: sourceImageUrl, country: 'us' });
      results = formatMatches(data);
    } else {
      return res.status(400).json({ error: 'Please provide an image or URL.' });
    }

    res.json({ results, sourceImage: sourceImageUrl });
  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).json({ error: 'Search failed: ' + err.message });
  }
});

// Watchlist
app.get('/api/watchlist', (req, res) => res.json(loadWatchlist()));

app.post('/api/watchlist', (req, res) => {
  const list = loadWatchlist();
  const item = { ...req.body, id: Date.now(), addedAt: new Date().toISOString(), priceHistory: [] };
  list.push(item);
  saveWatchlist(list);
  res.json(item);
});

app.delete('/api/watchlist/:id', (req, res) => {
  saveWatchlist(loadWatchlist().filter(i => String(i.id) !== req.params.id));
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

// Price check
async function checkPrices() {
  const apiKey = process.env.SERPAPI_KEY;
  const alertEmail = process.env.ALERT_EMAIL;
  if (!apiKey || !alertEmail) return;
  const list = loadWatchlist();
  const drops = [];
  for (const item of list) {
    if (!item.sourceImage) continue;
    try {
      const data = await serpGet({ api_key: apiKey, engine: 'google_lens', url: item.sourceImage, country: 'us' });
      const prices = formatMatches(data).map(r => parseFloat((r.price || '').replace(/[^0-9.]/g, ''))).filter(p => !isNaN(p) && p > 0);
      if (!prices.length) continue;
      const lowestPrice = Math.min(...prices);
      item.priceHistory = item.priceHistory || [];
      item.priceHistory.push({ date: new Date().toISOString(), price: lowestPrice });
      item.currentPrice = lowestPrice;
      if (item.targetPrice && lowestPrice <= item.targetPrice) drops.push({ ...item, lowestPrice });
    } catch (e) { console.error('Price check error:', e.message); }
  }
  saveWatchlist(list);
  if (drops.length) await sendAlertEmail(alertEmail, drops);
}

async function sendAlertEmail(to, drops) {
  const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
  await transporter.sendMail({
    from: process.env.SMTP_USER, to,
    subject: `Price drop — ${drops.length} item${drops.length > 1 ? 's' : ''} hit your target`,
    html: `<h2 style="font-family:sans-serif">Price drop alert</h2>${drops.map(d => `<div style="font-family:sans-serif;border:1px solid #eee;border-radius:8px;padding:16px;margin:12px 0"><strong>${d.name}</strong><br>Now: <span style="color:#2d6a4f">$${d.lowestPrice}</span> &nbsp; Target: $${d.targetPrice}<br>${d.productUrl ? `<a href="${d.productUrl}">View item</a>` : ''}</div>`).join('')}`
  });
}

cron.schedule('0 */12 * * *', checkPrices);
app.post('/api/check-prices', async (req, res) => { await checkPrices(); res.json({ ok: true }); });
app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
