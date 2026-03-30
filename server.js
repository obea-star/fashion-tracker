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

// ── HTTP fetch utility ─────────────────────────────────────────────────────
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

// ── POST utility ───────────────────────────────────────────────────────────
function postRequest(hostname, path, body, contentType = 'application/json') {
  return new Promise((resolve, reject) => {
    const postData = typeof body === 'string' ? body : JSON.stringify(body);
    const req = https.request({
      hostname, path, method: 'POST',
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

// ── SerpAPI GET ────────────────────────────────────────────────────────────
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

// ── Upload image to ImgBB, returns public URL ──────────────────────────────
async function uploadToImgBB(base64) {
  const key = process.env.IMGBB_KEY;
  if (!key) throw new Error('IMGBB_KEY not set in Railway variables');
  const body = `key=${encodeURIComponent(key)}&image=${encodeURIComponent(base64)}`;
  const result = await postRequest('api.imgbb.com', '/1/upload', body, 'application/x-www-form-urlencoded');
  if (!result.success) throw new Error('ImgBB upload failed: ' + JSON.stringify(result.error));
  return result.data.url;
}

// ── Extract og:image from a URL ────────────────────────────────────────────
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

// ── Google Lens visual search ──────────────────────────────────────────────
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

// ── Google Shopping search for prices ─────────────────────────────────────
async function runShoppingSearch(query, apiKey) {
  const data = await serpGet({ api_key: apiKey, engine: 'google_shopping', q: query, country: 'us', num: 10 });
  return (data.shopping_results || []).slice(0, 10).map(r => ({
    title: r.title,
    price: r.price,
    source: r.source,
    link: r.link,
    thumbnail: r.thumbnail,
  }));
}

// ── Parse price string to number ───────────────────────────────────────────
function parsePrice(str) {
  if (!str) return null;
  const n = parseFloat(String(str).replace(/[^0-9.]/g, ''));
  return isNaN(n) ? null : n;
}

// ── Main search endpoint ───────────────────────────────────────────────────
app.post('/api/search', async (req, res) => {
  const { imageBase64, url } = req.body;
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) return res.status(400).json({ error: 'SERPAPI_KEY not set in Railway variables.' });

  try {
    let imageUrl = null;

    if (imageBase64) {
      // Upload to ImgBB to get a public URL
      imageUrl = await uploadToImgBB(imageBase64);
    } else if (url) {
      imageUrl = await getImageFromUrl(url);
      if (!imageUrl) {
        return res.status(422).json({ error: 'Could not extract image from that URL. Try saving the photo and uploading it directly.' });
      }
    } else {
      return res.status(400).json({ error: 'Please provide an image or URL.' });
    }

    // Step 1: Visual search
    const visualResults = await runLensSearch(imageUrl, apiKey);

    // Step 2: Shopping search using top visual match title for prices
    let shoppingResults = [];
    const topTitle = visualResults.find(r => r.title && r.title !== 'Unknown item')?.title;
    if (topTitle) {
      try {
        shoppingResults = await runShoppingSearch(topTitle, apiKey);
      } catch (e) {
        console.error('Shopping search failed:', e.message);
      }
    }

    // Step 3: Merge — prefer shopping results (have prices), supplement with visual
    const allResults = [...shoppingResults];
    for (const v of visualResults) {
      if (!allResults.find(r => r.source === v.source)) {
        allResults.push(v);
      }
    }

    // Find lowest price across all results
    const prices = allResults.map(r => parsePrice(r.price)).filter(Boolean);
    const lowestPrice = prices.length ? Math.min(...prices) : null;

    res.json({
      results: allResults.slice(0, 20),
      sourceImage: imageUrl,
      lowestPrice,
      searchQuery: topTitle,
    });

  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Watchlist CRUD ─────────────────────────────────────────────────────────
app.get('/api/watchlist', (req, res) => res.json(loadWatchlist()));

app.post('/api/watchlist', (req, res) => {
  const list = loadWatchlist();
  const now = new Date().toISOString();
  const item = {
    ...req.body,
    id: Date.now(),
    addedAt: now,
    priceHistory: req.body.currentPrice
      ? [{ date: now, price: parseFloat(req.body.currentPrice) }]
      : [],
  };
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

// ── Smart price check with tiered alerts ──────────────────────────────────
async function checkPrices(urgentOnly = false) {
  const apiKey = process.env.SERPAPI_KEY;
  const alertEmail = process.env.ALERT_EMAIL;
  if (!apiKey || !alertEmail) return;

  const list = loadWatchlist();
  const anyDrops = [];
  const saleDrops = [];
  const urgentDrops = [];

  for (const item of list) {
    if (!item.searchQuery && !item.name) continue;
    try {
      const query = item.searchQuery || item.name;
      const results = await runShoppingSearch(query, apiKey);

      // Only consider results from the same retailer if we know it
      // Otherwise take results whose title closely matches
      let relevantResults = results;
      if (item.retailer) {
        const retailerMatches = results.filter(r =>
          r.source && r.source.toLowerCase().includes(item.retailer.toLowerCase())
        );
        if (retailerMatches.length) relevantResults = retailerMatches;
      }

      const prices = relevantResults.map(r => parsePrice(r.price)).filter(p => p && p > 5);
      if (!prices.length) continue;

      const lowestPrice = Math.min(...prices);

      // savedPrice is LOCKED — never overwrite it
      // It represents what the item cost when you first saved it
      const baselinePrice = item.savedPrice || item.currentPrice;
      if (!baselinePrice) continue;

      // Sanity check — if new price is more than 3x the baseline, it's a bad match
      if (lowestPrice > baselinePrice * 3) continue;
      // If new price is less than 10% of baseline, also a bad match
      if (lowestPrice < baselinePrice * 0.1) continue;

      // Update currentPrice only — never touch savedPrice
      item.priceHistory = item.priceHistory || [];
      item.priceHistory.push({ date: new Date().toISOString(), price: lowestPrice });
      item.currentPrice = lowestPrice;

      const dropAmount = baselinePrice - lowestPrice;
      const dropPercent = (dropAmount / baselinePrice) * 100;

      if (dropPercent >= 30) {
        urgentDrops.push({ ...item, lowestPrice, dropPercent: Math.round(dropPercent), dropAmount: Math.round(dropAmount) });
      } else if (dropPercent >= 10) {
        saleDrops.push({ ...item, lowestPrice, dropPercent: Math.round(dropPercent), dropAmount: Math.round(dropAmount) });
      } else if (dropAmount > 0) {
        anyDrops.push({ ...item, lowestPrice, dropPercent: Math.round(dropPercent), dropAmount: Math.round(dropAmount) });
      }

      if (item.targetPrice && lowestPrice <= item.targetPrice) {
        if (!urgentDrops.find(d => d.id === item.id)) {
          urgentDrops.push({ ...item, lowestPrice, dropPercent: Math.round(dropPercent), dropAmount: Math.round(dropAmount), hitTarget: true });
        }
      }

    } catch (e) {
      console.error('Price check error for', item.name, e.message);
    }
  }

  saveWatchlist(list);

  // Send urgent alerts immediately
  if (urgentDrops.length) {
    await sendAlertEmail(alertEmail, urgentDrops, 'urgent');
  }

  // Send sale/any drop alerts only on scheduled checks
  if (!urgentOnly) {
    if (saleDrops.length) await sendAlertEmail(alertEmail, saleDrops, 'sale');
    if (anyDrops.length) await sendAlertEmail(alertEmail, anyDrops, 'any');
  }
}

async function sendAlertEmail(to, items, type) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });

  const subjects = {
    urgent: `🚨 Urgent price drop — ${items.length} item${items.length > 1 ? 's' : ''} dropped 30%+`,
    sale: `🏷️ Sale alert — ${items.length} item${items.length > 1 ? 's' : ''} on sale`,
    any: `📉 Price drop — ${items.length} item${items.length > 1 ? 's' : ''} decreased`,
  };

  const colors = { urgent: '#9b2335', sale: '#1a4480', any: '#2d6a4f' };
  const color = colors[type];

  await transporter.sendMail({
    from: process.env.SMTP_USER,
    to,
    subject: subjects[type],
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
        <h2 style="color:${color}">${subjects[type]}</h2>
        ${items.map(item => `
          <div style="border:1px solid #eee;border-radius:10px;padding:16px;margin:12px 0;display:flex;gap:16px">
            ${item.imageUrl ? `<img src="${item.imageUrl}" style="width:80px;height:80px;object-fit:cover;border-radius:6px;flex-shrink:0">` : ''}
            <div>
              <strong style="font-size:15px">${item.name}</strong><br>
              ${item.hitTarget ? `<span style="color:${color};font-weight:500">Hit your target price!</span><br>` : ''}
              <span style="color:${color};font-size:18px;font-weight:500">Now $${item.lowestPrice}</span>
              ${item.currentPrice ? `&nbsp;<span style="color:#999;text-decoration:line-through">was $${item.savedPrice || item.currentPrice}</span>` : ''}
              ${item.dropPercent ? `&nbsp;<span style="background:${color};color:white;padding:2px 8px;border-radius:4px;font-size:12px">-${item.dropPercent}%</span>` : ''}<br>
              ${item.productUrl ? `<a href="${item.productUrl}" style="color:${color}">View item →</a>` : ''}
            </div>
          </div>
        `).join('')}
        <p style="color:#999;font-size:12px;margin-top:24px">Your Fashion Tracker — checking prices every 12 hours</p>
      </div>
    `
  });
}

// ── Scheduled checks ───────────────────────────────────────────────────────
// Full check every 12 hours
cron.schedule('0 */12 * * *', () => {
  console.log('Running scheduled price check...');
  checkPrices(false);
});

// Urgent-only check every hour
cron.schedule('0 * * * *', () => {
  console.log('Running urgent price check...');
  checkPrices(true);
});

app.post('/api/check-prices', async (req, res) => {
  await checkPrices(false);
  res.json({ ok: true });
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Serve the frontend
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
