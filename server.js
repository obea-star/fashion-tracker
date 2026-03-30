const express = require('express');
const cors = require('cors');
const axios = require('axios');
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

// ── Detect what kind of URL was submitted ──────────────────────────────────
function detectUrlType(url) {
  if (!url) return 'unknown';
  if (url.includes('pinterest.com') || url.includes('pin.it')) return 'pinterest';
  if (url.includes('instagram.com')) return 'instagram';
  return 'product';
}

// ── Extract image URL from a Pinterest page ────────────────────────────────
async function extractPinterestImage(url) {
  try {
    const res = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 10000
    });
    const $ = cheerio.load(res.data);

    // Try og:image meta tag first (most reliable)
    const ogImage = $('meta[property="og:image"]').attr('content');
    if (ogImage) return ogImage;

    // Try Twitter card image
    const twitterImage = $('meta[name="twitter:image"]').attr('content');
    if (twitterImage) return twitterImage;

    // Try first large img tag
    const img = $('img[src*="pinimg.com"]').first().attr('src');
    if (img) return img;

    return null;
  } catch (err) {
    console.error('Pinterest extract error:', err.message);
    return null;
  }
}

// ── Extract image URL from an Instagram page ──────────────────────────────
async function extractInstagramImage(url) {
  try {
    const res = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 10000
    });
    const $ = cheerio.load(res.data);
    const ogImage = $('meta[property="og:image"]').attr('content');
    if (ogImage) return ogImage;
    return null;
  } catch (err) {
    console.error('Instagram extract error:', err.message);
    return null;
  }
}

// ── Extract image + price from a direct product URL ───────────────────────
async function extractProductInfo(url) {
  try {
    const res = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      timeout: 10000
    });
    const $ = cheerio.load(res.data);

    const image =
      $('meta[property="og:image"]').attr('content') ||
      $('meta[name="twitter:image"]').attr('content') ||
      $('img.product-image, img.hero-image, img[class*="product"]').first().attr('src') ||
      null;

    const title =
      $('meta[property="og:title"]').attr('content') ||
      $('h1').first().text().trim() ||
      null;

    // Try to find price in meta or common price selectors
    const priceRaw =
      $('meta[property="product:price:amount"]').attr('content') ||
      $('[class*="price"]:not([class*="was"]):not([class*="old"])').first().text().trim() ||
      null;

    const price = priceRaw ? priceRaw.replace(/[^0-9.]/g, '') : null;

    return { image, title, price };
  } catch (err) {
    console.error('Product extract error:', err.message);
    return { image: null, title: null, price: null };
  }
}

// ── Run Google Lens visual search via SerpAPI ──────────────────────────────
async function runLensSearch(imageUrl, apiKey) {
  const res = await axios.get('https://serpapi.com/search', {
    params: {
      api_key: apiKey,
      engine: 'google_lens',
      url: imageUrl,
      country: 'us',
    },
    timeout: 30000
  });

  const matches = res.data.visual_matches || [];
  return matches.slice(0, 16).map(m => ({
    title: m.title || 'Unknown item',
    price: m.price || null,
    source: m.source || null,
    link: m.link || null,
    thumbnail: m.thumbnail || null,
  }));
}

// ── Run Google Lens on a base64 image via SerpAPI ─────────────────────────
async function runLensSearchBase64(base64, apiKey) {
  // SerpAPI Google Lens accepts a direct image URL — we need to host it
  // Use SerpAPI's image upload endpoint
  const res = await axios.post('https://serpapi.com/search', {
    api_key: apiKey,
    engine: 'google_lens',
    image_content: base64,
    country: 'us',
  }, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 30000
  });

  const matches = res.data.visual_matches || [];
  return matches.slice(0, 16).map(m => ({
    title: m.title || 'Unknown item',
    price: m.price || null,
    source: m.source || null,
    link: m.link || null,
    thumbnail: m.thumbnail || null,
  }));
}

// ── Main search endpoint ───────────────────────────────────────────────────
app.post('/api/search', async (req, res) => {
  const { imageBase64, url } = req.body;
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) return res.status(400).json({ error: 'SERPAPI_KEY not configured' });

  try {
    let results = [];
    let sourceImageUrl = null;
    let extractedTitle = null;
    let extractedPrice = null;

    if (imageBase64) {
      // Photo upload — run Lens directly
      results = await runLensSearchBase64(imageBase64, apiKey);

    } else if (url) {
      const urlType = detectUrlType(url);

      if (urlType === 'pinterest') {
        sourceImageUrl = await extractPinterestImage(url);
        if (!sourceImageUrl) return res.status(422).json({ error: 'Could not extract image from Pinterest link. Try downloading the image and uploading it directly.' });
        results = await runLensSearch(sourceImageUrl, apiKey);

      } else if (urlType === 'instagram') {
        sourceImageUrl = await extractInstagramImage(url);
        if (!sourceImageUrl) return res.status(422).json({ error: 'Could not extract image from Instagram. Instagram often blocks this — try saving the photo and uploading it directly.' });
        results = await runLensSearch(sourceImageUrl, apiKey);

      } else {
        // Direct product URL
        const info = await extractProductInfo(url);
        extractedTitle = info.title;
        extractedPrice = info.price;
        sourceImageUrl = info.image;

        if (!sourceImageUrl) return res.status(422).json({ error: 'Could not extract product image from this URL. Try uploading a screenshot of the product instead.' });
        results = await runLensSearch(sourceImageUrl, apiKey);
      }
    } else {
      return res.status(400).json({ error: 'Please provide either an image upload or a URL.' });
    }

    res.json({
      results,
      sourceImage: sourceImageUrl,
      extractedTitle,
      extractedPrice,
    });

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
    if (!item.sourceImage && !item.name) continue;
    try {
      let results = [];
      if (item.sourceImage) {
        results = await runLensSearch(item.sourceImage, apiKey);
      }

      const prices = results
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
        <div style="font-family:sans-serif;border:1px solid #eee;border-radius:8px;padding:16px;margin:12px 0;display:flex;gap:16px;align-items:center">
          ${d.imageUrl ? `<img src="${d.imageUrl}" style="width:80px;height:80px;object-fit:cover;border-radius:6px">` : ''}
          <div>
            <strong>${d.name}</strong><br>
            Now: <span style="color:#2d6a4f;font-size:1.2em;font-weight:500">$${d.lowestPrice}</span>
            &nbsp;<span style="color:#999">Your target: $${d.targetPrice}</span><br>
            ${d.productUrl ? `<a href="${d.productUrl}" style="color:#1a4480">View item →</a>` : ''}
          </div>
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
