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

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDB() {
  await pool.query(`CREATE TABLE IF NOT EXISTS watchlist (id BIGINT PRIMARY KEY, data JSONB NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW())`);
  const existing = await pool.query('SELECT id, data FROM watchlist');
  for (const row of existing.rows) {
    const item = row.data;
    let changed = false;
    if (item.currentPrice && item.savedPrice && item.currentPrice !== item.savedPrice) { item.currentPrice = item.savedPrice; changed = true; }
    const aggregators = ['lyst', 'outcast', 'farfetch', 'ssense', 'shopstyle'];
    if (!item.verified && !item.needsVerification) { item.needsVerification = aggregators.some(a => (item.retailer || '').toLowerCase().includes(a)); changed = true; }
    if (!item.size && !item.noSize && item.needsSize === undefined) { item.needsSize = true; changed = true; }
    if (changed) await pool.query('UPDATE watchlist SET data = $1 WHERE id = $2', [JSON.stringify(item), row.id]);
  }
  console.log('Database ready');
}

async function loadWatchlist() {
  const r = await pool.query('SELECT data FROM watchlist ORDER BY created_at ASC');
  return r.rows.map(r => r.data);
}
async function saveItem(item) {
  await pool.query('INSERT INTO watchlist (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = $2', [item.id, JSON.stringify(item)]);
}
async function removeItem(id) { await pool.query('DELETE FROM watchlist WHERE id = $1', [id]); }
async function updateItem(id, updates) {
  const r = await pool.query('SELECT data FROM watchlist WHERE id = $1', [id]);
  if (!r.rows.length) return null;
  const updated = { ...r.rows[0].data, ...updates };
  await pool.query('UPDATE watchlist SET data = $1 WHERE id = $2', [JSON.stringify(updated), id]);
  return updated;
}

function fetchUrl(urlStr) {
  return new Promise((resolve, reject) => {
    const lib = urlStr.startsWith('https') ? https : http;
    const req = lib.get(urlStr, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36', 'Accept-Language': 'en-US,en;q=0.9', 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8' },
      timeout: 20000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return fetchUrl(res.headers.location).then(resolve).catch(reject);
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
    const req = https.request({ hostname, path: pathStr, method: 'POST', headers: { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(postData) }, timeout: 30000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Bad JSON')); } });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function serpGet(params) {
  const qs = new URLSearchParams(params).toString();
  return new Promise((resolve, reject) => {
    https.get(`https://serpapi.com/search?${qs}`, { headers: { 'User-Agent': 'Node.js' }, timeout: 30000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Bad JSON from SerpAPI')); } });
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

function extractMeta(html, prop) {
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${prop}["']`, 'i'),
    new RegExp(`<meta[^>]+name=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${prop}["']`, 'i'),
  ];
  for (const re of patterns) { const m = html.match(re); if (m && m[1]) return m[1]; }
  return null;
}

function extractPrice(html) {
  const blocks = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of blocks) {
    try {
      const data = JSON.parse(block.replace(/<script[^>]*>/, '').replace(/<\/script>/, ''));
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item.offers) {
          const offer = Array.isArray(item.offers) ? item.offers[0] : item.offers;
          if (offer.price) return parseFloat(offer.price);
        }
      }
    } catch (e) {}
  }
  const metaPrice = extractMeta(html, 'product:price:amount');
  if (metaPrice) return parseFloat(metaPrice);
  const patterns = [/"price":\s*"?\$?([\d.]+)"?/, /itemprop="price"[^>]*content="([\d.]+)"/i, /class="[^"]*price[^"]*"[^>]*>\s*\$?([\d,]+\.?\d*)/i];
  for (const re of patterns) { const m = html.match(re); if (m) { const p = parseFloat(m[1].replace(',', '')); if (p > 0) return p; } }
  return null;
}

function extractSizeAvailability(html, targetSize) {
  if (!targetSize || targetSize === 'none') return { available: null, checked: false };
  const sizeLower = targetSize.toLowerCase().trim();
  const blocks = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of blocks) {
    try {
      const data = JSON.parse(block.replace(/<script[^>]*>/, '').replace(/<\/script>/, ''));
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item.offers) {
          const offers = Array.isArray(item.offers) ? item.offers : [item.offers];
          const sizeOffers = offers.filter(o => (o.name || o.sku || '').toLowerCase().includes(sizeLower));
          if (sizeOffers.length) {
            const inStock = sizeOffers.some(o => (o.availability || '').toLowerCase().includes('instock') || (o.availability || '').toLowerCase().includes('in_stock'));
            return { available: inStock, checked: true };
          }
        }
      }
    } catch (e) {}
  }
  const region = html.match(new RegExp(`.{0,300}\\b${sizeLower}\\b.{0,300}`, 'gi'));
  if (region) {
    for (const r of region) {
      const rl = r.toLowerCase();
      if (['out of stock', 'sold out', 'unavailable'].some(t => rl.includes(t))) return { available: false, checked: true };
      if (['add to cart', 'add to bag', 'in stock'].some(t => rl.includes(t))) return { available: true, checked: true };
    }
  }
  return { available: null, checked: false };
}

const AGGREGATORS = ['lyst', 'shopstyle', 'stylight', 'farfetch', 'ssense', 'nordstrom rack', 'poshmark', 'depop', 'ebay', 'etsy', 'amazon', 'walmart', 'wish', 'aliexpress', 'shein', 'pinterest', 'instagram'];

function scorePrimary(result) {
  let score = 0;
  const source = (result.source || '').toLowerCase();
  const link = (result.link || '').toLowerCase();
  if (AGGREGATORS.some(a => source.includes(a) || link.includes(a))) score -= 50;
  if (result.price) score += 20;
  if (link.match(/\/[a-z0-9-]{5,}\/[a-z0-9-]{5,}/)) score += 15;
  if (link.match(/[?&](q|query|search|s)=/)) score -= 20;
  const sourceName = source.split(' ')[0];
  if (sourceName.length > 3 && link.includes(sourceName)) score += 35;
  if ((result.position || 5) <= 3) score += 10;
  return score;
}

function detectCategory(title) {
  const t = (title || '').toLowerCase();
  if (t.match(/shoe|boot|sneaker|heel|sandal|loafer/)) return 'shoes';
  if (t.match(/bag|purse|handbag|clutch|tote/)) return 'bags';
  if (t.match(/jewelry|necklace|ring|earring|bracelet/)) return 'jewelry';
  if (t.match(/sunglass|glasses|eyewear/)) return 'sunglasses';
  if (t.match(/swim|bikini|bodysuit|swimwear/)) return 'swimwear';
  return 'clothing';
}

app.post('/api/search', async (req, res) => {
  const { imageBase64, url } = req.body;
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) return res.status(400).json({ error: 'SERPAPI_KEY not set.' });

  try {
    let imageUrl = null;
    let submittedUrlData = null;

    if (imageBase64) {
      imageUrl = await uploadToImgBB(imageBase64);
    } else if (url) {
      try {
        const html = await fetchUrl(url);
        imageUrl = extractMeta(html, 'og:image') || extractMeta(html, 'twitter:image');
        const price = extractPrice(html);
        const title = extractMeta(html, 'og:title') || '';
        const siteName = extractMeta(html, 'og:site_name') || '';
        const isPrimary = !AGGREGATORS.some(a => url.toLowerCase().includes(a));
        submittedUrlData = { url, price, title, siteName, isPrimary, thumbnail: imageUrl };
      } catch (e) {}
      if (!imageUrl) return res.status(422).json({ error: 'Could not extract image from that URL. Try uploading a photo directly.' });
    } else {
      return res.status(400).json({ error: 'Please provide an image or URL.' });
    }

    const lensData = await serpGet({ api_key: apiKey, engine: 'google_lens', url: imageUrl, country: 'us' });
    const visual = (lensData.visual_matches || []).slice(0, 20);

    const scored = visual.map((m, i) => ({
      title: m.title || 'Unknown item',
      price: m.price || null,
      source: m.source || null,
      link: m.link || null,
      thumbnail: m.thumbnail || null,
      position: i + 1,
      score: scorePrimary({ ...m, position: i + 1 }),
    })).sort((a, b) => b.score - a.score);

    // Build primary candidates — always take top 3 by score, no hard cutoff
    let primaryCandidates = scored.slice(0, 3);

    // If all top results are aggregators, still show them but flag as needing verification
    primaryCandidates = primaryCandidates.map(r => ({
      ...r,
      isAggregator: AGGREGATORS.some(a => (r.source || '').toLowerCase().includes(a) || (r.link || '').toLowerCase().includes(a))
    }));

    // If submitted URL is a direct brand page, put it first
    if (submittedUrlData?.isPrimary && submittedUrlData.title) {
      const alreadyIn = primaryCandidates.find(c => c.link === submittedUrlData.url);
      if (!alreadyIn) {
        primaryCandidates = [{
          title: submittedUrlData.title,
          price: submittedUrlData.price ? `$${submittedUrlData.price}` : null,
          source: submittedUrlData.siteName,
          link: submittedUrlData.url,
          thumbnail: submittedUrlData.thumbnail || imageUrl,
          score: 100,
          isSubmitted: true,
        }, ...primaryCandidates].slice(0, 3);
      }
    }

    const topSource = (primaryCandidates[0]?.source || '').toLowerCase();
    const primaryLinks = new Set(primaryCandidates.map(r => r.link).filter(Boolean));
    const replicas = scored
      .filter(r => {
        const s = (r.source || '').toLowerCase();
        return !primaryLinks.has(r.link) && s !== topSource && r.thumbnail;
      })
      .slice(0, 3);

    const category = detectCategory(primaryCandidates[0]?.title || '');

    res.json({ primaryCandidates, replicas, sourceImage: imageUrl, category, submittedUrlVerified: submittedUrlData?.isPrimary });
  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/watchlist', async (req, res) => { try { res.json(await loadWatchlist()); } catch (e) { res.status(500).json({ error: e.message }); } });

app.post('/api/watchlist', async (req, res) => {
  try {
    const now = new Date().toISOString();
    const item = { ...req.body, id: Date.now(), addedAt: now, verified: true, needsVerification: false, needsSize: !req.body.size && !req.body.noSize, priceHistory: req.body.savedPrice ? [{ date: now, price: parseFloat(req.body.savedPrice) }] : [] };
    await saveItem(item);
    res.json(item);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/watchlist/:id', async (req, res) => { try { await removeItem(req.params.id); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); } });

app.put('/api/watchlist/:id', async (req, res) => {
  try { const u = await updateItem(req.params.id, req.body); if (!u) return res.status(404).json({ error: 'Not found' }); res.json(u); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

async function checkPrices(urgentOnly = false) {
  const alertEmail = process.env.ALERT_EMAIL;
  if (!alertEmail) return;
  const list = await loadWatchlist();
  const priceAlerts = [], sizeAlerts = [];

  for (const item of list) {
    if (!item.productUrl) continue;
    try {
      const html = await fetchUrl(item.productUrl);
      const currentPrice = extractPrice(html);
      const sizeCheck = (item.size && !item.noSize) ? extractSizeAvailability(html, item.size) : { available: null, checked: false };
      const now = new Date().toISOString();
      const baselinePrice = item.savedPrice;

      if (currentPrice && baselinePrice && currentPrice > baselinePrice * 0.1 && currentPrice < baselinePrice * 2) {
        const priceHistory = [...(item.priceHistory || []), { date: now, price: currentPrice }];
        await updateItem(String(item.id), { currentPrice, priceHistory });
        const dropAmount = baselinePrice - currentPrice;
        const dropPercent = (dropAmount / baselinePrice) * 100;
        const sensitivity = item.alertSensitivity || 'any';
        const shouldAlert = (sensitivity === 'any' && dropAmount > 0) || (sensitivity === 'sale' && dropPercent >= 10) || (sensitivity === 'urgent' && dropPercent >= 30) || (item.targetPrice && currentPrice <= item.targetPrice);
        if (shouldAlert && (!urgentOnly || dropPercent >= 30 || (item.targetPrice && currentPrice <= item.targetPrice))) {
          priceAlerts.push({ ...item, currentPrice, dropAmount: Math.round(dropAmount), dropPercent: Math.round(dropPercent), hitTarget: !!(item.targetPrice && currentPrice <= item.targetPrice) });
        }
      }

      if (sizeCheck.checked) {
        if (sizeCheck.available === true) {
          if (item.lastSizeStatus === 'out' || !item.lastSizeStatus) sizeAlerts.push(item);
          await updateItem(String(item.id), { lastSizeStatus: 'in' });
        } else if (sizeCheck.available === false) {
          await updateItem(String(item.id), { lastSizeStatus: 'out' });
        }
      }
    } catch (e) { console.error('Check error:', item.name, e.message); }
  }

  if (priceAlerts.length) await sendAlert(alertEmail, priceAlerts, 'price');
  if (sizeAlerts.length) await sendAlert(alertEmail, sizeAlerts, 'size');
}

async function sendAlert(to, items, type) {
  const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
  const subject = type === 'price' ? `📉 Price drop on ${items.length} item${items.length > 1 ? 's' : ''} you're watching` : `✅ Back in stock in your size — ${items.length} item${items.length > 1 ? 's' : ''}`;
  const color = type === 'price' ? '#2d6a4f' : '#1a4480';
  await transporter.sendMail({
    from: process.env.SMTP_USER, to, subject,
    html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto"><h2 style="color:${color}">${subject}</h2>${items.map(item => `
      <div style="border:1px solid #eee;border-radius:10px;padding:16px;margin:12px 0;display:flex;gap:16px;align-items:flex-start">
        ${item.imageUrl ? `<img src="${item.imageUrl}" style="width:80px;height:80px;object-fit:cover;border-radius:6px;flex-shrink:0">` : ''}
        <div><strong>${item.name}</strong><br><span style="color:#999">${item.retailer || ''}</span><br><br>
        ${type === 'price' ? `${item.hitTarget ? `<span style="color:${color};font-weight:500">Hit your target!</span><br>` : ''}<span style="color:${color};font-size:20px;font-weight:600">$${item.currentPrice}</span>${item.savedPrice ? ` <span style="color:#999;text-decoration:line-through">$${item.savedPrice}</span>` : ''}${item.dropPercent ? ` <span style="background:${color};color:white;padding:2px 8px;border-radius:4px;font-size:12px">-${item.dropPercent}%</span>` : ''}` : `<span style="color:${color};font-weight:500">Size ${item.size} is back in stock!</span>`}
        <br><br>${item.productUrl ? `<a href="${item.productUrl}" style="background:${color};color:white;padding:8px 16px;border-radius:6px;text-decoration:none;font-size:13px">Shop now →</a>` : ''}</div>
      </div>`).join('')}<p style="color:#999;font-size:12px;margin-top:24px">Your Fashion Tracker</p></div>`
  });
}

cron.schedule('0 */6 * * *', () => checkPrices(false));
cron.schedule('0 * * * *', () => checkPrices(true));
app.post('/api/check-prices', async (req, res) => { await checkPrices(false); res.json({ ok: true }); });
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3001;
initDB().then(() => app.listen(PORT, () => console.log(`Server running on port ${PORT}`))).catch(err => { console.error('DB init failed:', err); process.exit(1); });
