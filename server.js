const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const cheerio = require('cheerio');

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

// ── Simple HTTP/HTTPS fetch (no axios, avoids File compatibility issues) ───
function fetchUrl(url, options = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const opts = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        ...options.headers
      },
      timeout: 15000,
    };
    const req = lib.get(url, opts, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, options).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ data, statusCode: res.statusCode }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

// ── SerpAPI GET request ────────────────────────────────────────────────────
function serpGet(params) {
  const qs = new URLSearchParams(params).toString();
  const url = `https://serpapi.com/search?${qs}`;
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: { 'User-Agent': 'Node.js' },
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON from SerpAPI')); }
      });
    }).on('error', reject).on('timeout', () => reject(new Error('SerpAPI timeout')));
  });
}

// ── SerpAPI POST for base64 image ──────────────────────────────────────────
function serpPost(body) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body);
    const options = {
      hostname: 'serpapi.com',
      path: '/search',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
      timeout: 30000,
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON from SerpAPI')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('SerpAPI timeout')); });
    req.write(postData);
    req.end();
  });
}

// ── Format visual match results ────────────────────────────────────────────
function formatMatches(data) {
  const matches = data.visual_matches || [];
  return matches.slice(0, 16).map(m => ({
    title: m.title || 'Unknown item',
    price: m.price || null,
    source: m.source || null,
    link: m.link || null,
    thumbnail: m.thumbnail || null,
  }));
}

// ── Detect URL type ────────────────────────────────────────────────────────
function detectUrlType(url) {
  if (!url) return 'unknown';
  if (url.includes('pinterest.com') || url.includes('pin.it')) return 'pinterest';
  if (url.includes('instagram.com')) return 'instagram';
  return 'product';
}

// ── Extract og:image from any page ────────────────────────────────────────
async function extractOgImage(url) {
  try {
    const { data } = await fetchUrl(url);
    const $ = cheerio.load(data);
    return (
      $('meta[property="og:image"]').attr('content') ||
      $('meta[name="twitter:image"]').attr('content') ||
      $('img[src*="pinimg.com"]').first().attr('src') ||
      null
    );
  } catch (err) {
    console.error('Image extract error:', err.message);
    return null;
  }
}

// ── Extract product info from direct URL ──────────────────────────────────
async function extractProductInfo(url) {
  try {
    const { data } = await fetchUrl(url);
    const $ = cheerio.load(data);
    const image =
      $('meta[property="og:image"]').attr('content') ||
      $('meta[name="twitter:image"]').attr('content') || null;
    const title =
      $('meta[property="og:title"]').attr('content') ||
      $('h1').first().text().trim() || null;
    const priceRaw =
      $('meta[property="product:price:amount"]').attr('content') ||
      $('[class*="price"]:not([class*="was"]):not([class*="old"])').first().text().trim() || null;
    const price = priceRaw ? priceRaw.replace(/[^0-9.]/g, '') : null;
    return { image, title, price };
  } catch (err) {
    console.error('Product extract error:', err.message);
    return { image: null, title: null, price: null };
  }
}

// ── Main search endpoint ───────────────────────────────────────────────────
app.post('/api/search', async (req, res) => {
  const { imageBase64, url } = req.body;
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) return res.status(400).json({ error: 'SERPAPI_KEY not configured in Railway variables.' });

  try {
    let results = [];
    let sourceImageUrl = null;
    let extractedTitle = null;
    let extractedPrice = null;

    if (imageBase64) {
      const data = await serpPost({
        api_key: apiKey,
        engine: 'google_lens',
        image_content: imageBase64,
        country: 'us',
      });
      results = formatMatches(data);

    } else if (url) {
      const urlType = detectUrlType(url);

      if (urlType === 'pinterest') {
        sourceImageUrl = await extractOgImage(url);
        if (!sourceImageUrl) {
          return res.status(422).json({ error: 'Could not extract image from Pinterest. Try saving the photo and uploading it directly instead.' });
        }
        const data = await serpGet({ api_key: apiKey, engine: 'google_lens', url: sourceImageUrl, country: 'us' });
        results = formatMatches(data);

      } else if (urlType === 'instagram') {
        sourceImageUrl = await extractOgImage(url);
        if (!sourceImageUrl) {
          return res.status(422).json({ error: 'Could not extract image from Instagram — Instagram often blocks this. Try saving the photo and uploading it directly.' });
        }
        const data = await serpGet({ api_key: apiKey, engine: 'google_lens', url: sourceImageUrl, country: 'us' });
        results = formatMatches(data);

      } else {
        const info = await extractProductInfo(url);
        extractedTitle = info.title;
        extractedPrice = info.price;
        sourceImageUrl = info.image;
        if (!sourceImageUrl) {
          return res.status(422).json({ error: 'Could not extract product image from this URL. Try uploading a screenshot of the product instead.' });
        }
        const data = await serpGet({ api_key: apiKey, engine: 'google_lens', url: sourceImageUrl, country: 'us' });
        results = formatMatches(data);
      }
    } else {
      return res.status(400).json({ error: 'Please provide either an image upload or a URL.' });
    }

    res.json({ results, sourceImage: sourceImageUrl, extractedTitle, extractedPrice });

  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).json({ error: 'Search failed: ' + err.message });
  }
});

// ── Watchlist CRUD ─────────────────────────────────────────────────────────
app.get('/api/watchlist', (req, res) => res.json(loadWatchlist()));

app.post('/api/watchlist', (req, res) => {
  const list = loadWatchlist();
  const item = {
    ...req.body,
    id: Date.now(),
    addedAt: new Date().toISOString(),
    priceHistory: req.body.price ? [{ date: new Date().toISOString(), price: parseFloat(req.body.price) }] : []
  };
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

// ── Price monitoring ───────────────────────────────────────────────────────
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
      const matches = formatMatches(data);
      const prices = matches
        .map(r => parseFloat((r.price || '').replace(/[^0-9.]/g, '')))
        .filter(p => !isNaN(p) && p > 0);

      if (!prices.length) continue;
      const lowestPrice = Math.min(...prices);
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
  if (drops.length > 0) await sendAlertEmail(alertEmail, drops);
}

async function sendAlertEmail(to, drops) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
  await transporter.sendMail({
    from: process.env.SMTP_USER,
    to,
    subject: `Price drop — ${drops.length} item${drops.length > 1 ? 's' : ''} hit your target`,
    html: `
      <h2 style="font-family:sans-serif;font-weight:400">Price drop alert</h2>
      <p style="font-family:sans-serif;color:#666">The following items hit your target price:</p>
      ${drops.map(d => `
        <div style="font-family:sans-serif;border:1px solid #eee;border-radius:8px;padding:16px;margin:12px 0">
          <strong>${d.name}</strong><br>
          Now: <span style="color:#2d6a4f;font-size:1.2em;font-weight:500">$${d.lowestPrice}</span>
          &nbsp;<span style="color:#999">Your target: $${d.targetPrice}</span><br>
          ${d.productUrl ? `<a href="${d.productUrl}">View item →</a>` : ''}
        </div>
      `).join('')}
    `
  });
}

cron.schedule('0 */12 * * *', () => {
  console.log('Running scheduled price check...');
  checkPrices();
});

app.post('/api/check-prices', async (req, res) => {
  await checkPrices();
  res.json({ ok: true });
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
