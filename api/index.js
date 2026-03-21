const express = require('express');
const fetch = require('node-fetch');
const xml2js = require('xml2js');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// In-memory store (Vercel KV or Supabase in production)
const pages = {};

// ─── Parse Substack URL to get publication slug ──────────────────────────────
function parseSubstackUrl(input) {
  let clean = input.trim().toLowerCase();
  if (!clean.includes('.') && !clean.includes('/')) return clean;
  clean = clean.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const substackMatch = clean.match(/^([a-z0-9_-]+)\.substack\.com/);
  if (substackMatch) return substackMatch[1];
  return clean.split('/')[0];
}

// ─── Fetch & parse a Substack RSS feed ───────────────────────────────────────
async function fetchSubstackFeed(publication) {
  const urls = [
    `https://${publication}.substack.com/feed`,
    `https://${publication}/feed`
  ];

  let lastError;
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; stackpub/1.0)' },
        redirect: 'follow',
        timeout: 8000
      });
      if (!res.ok) continue;
      const xml = await res.text();
      if (!xml.includes('<rss')) continue;

      const parsed = await xml2js.parseStringPromise(xml, { explicitArray: false });
      const channel = parsed.rss.channel;
      const items = Array.isArray(channel.item) ? channel.item : channel.item ? [channel.item] : [];

      const posts = items.map(item => {
        const title = item.title || '';
        const link = item.link || '';

        let img = '';
        if (item.enclosure && item.enclosure.$ && item.enclosure.$.url) {
          img = item.enclosure.$.url;
        }
        if (!img && item['media:content'] && item['media:content'].$) {
          img = item['media:content'].$.url || '';
        }
        if (!img) {
          const content = item['content:encoded'] || '';
          const match = content.match(/<img[^>]+src=["']([^"']+)["']/);
          if (match) img = match[1];
        }

        const utmLink = link.includes('?')
          ? `${link}&utm_source=stackpub&utm_medium=portfolio&utm_campaign=grid`
          : `${link}?utm_source=stackpub&utm_medium=portfolio&utm_campaign=grid`;

        return { title, link: utmLink, img };
      }).filter(p => p.title && p.link);

      const name = channel.title || publication;
      const logo = channel.image?.url || '';
      const substackUrl = channel.link || `https://${publication}.substack.com`;

      return { name, logo, substackUrl, posts };
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(lastError?.message || `Could not fetch feed for "${publication}"`);
}

// ─── API: register a new page ────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  const { substackUrl, displayName, logoUrl, imageStyle } = req.body;
  if (!substackUrl) return res.status(400).json({ error: 'Substack URL is required' });

  const slug = parseSubstackUrl(substackUrl);
  if (!slug) return res.status(400).json({ error: 'Could not parse that URL' });

  try {
    const feed = await fetchSubstackFeed(slug);
    pages[slug] = {
      slug,
      displayName: displayName || feed.name || slug,
      logoUrl: logoUrl || feed.logo || '',
      imageStyle: imageStyle || 'clean',
      substackUrl: feed.substackUrl,
      posts: feed.posts,
      updatedAt: new Date().toISOString()
    };
    res.json({ ok: true, url: `/${slug}`, postCount: feed.posts.length });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ─── API: refresh ────────────────────────────────────────────────────────────
app.get('/api/refresh/:slug', async (req, res) => {
  const slug = req.params.slug;
  if (!pages[slug]) return res.status(404).json({ error: 'Page not found' });
  try {
    const feed = await fetchSubstackFeed(slug);
    pages[slug].posts = feed.posts;
    pages[slug].updatedAt = new Date().toISOString();
    res.json({ ok: true, postCount: feed.posts.length });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ─── Homepage ────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ─── Serve portfolio page ────────────────────────────────────────────────────
app.get('/:slug', (req, res) => {
  const slug = req.params.slug.toLowerCase();
  if (slug === 'api' || slug === 'favicon.ico') return res.status(404).end();
  const page = pages[slug];
  if (!page) return res.status(404).send(notFoundHTML(slug));
  res.send(renderPage(page));
});

// ─── Render portfolio page with selected card style ──────────────────────────
function renderPage({ slug, displayName, logoUrl, imageStyle, substackUrl, posts, updatedAt }) {
  const header = logoUrl
    ? `<img class="logo" src="${logoUrl}" alt="${esc(displayName)}" />`
    : `<div class="site-name">${esc(displayName)}</div>`;

  const style = imageStyle || 'clean';

  const cards = posts.map(p => {
    const imgTag = p.img
      ? `<img src="${p.img}" alt="${esc(p.title)}" loading="lazy" onerror="this.style.display='none'" />`
      : '';
    return `
    <a class="card card-${style}" href="${p.link}" target="_blank" rel="noopener">
      ${imgTag}
      <div class="overlay">
        <span class="card-title">${esc(p.title)}</span>
        <span class="card-pub">${esc(displayName)}</span>
      </div>
    </a>`;
  }).join('\n');

  // Style-specific CSS for the overlay
  const styleCSS = {
    clean: `
      .card-clean { background: #1a1a1a; }
      .card-clean img { filter: brightness(0.5); }
      .card-clean:hover img { filter: brightness(0.6); transform: scale(1.03); }
      .card-clean .overlay {
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        text-align: center; padding: 16px;
      }
      .card-clean .card-title {
        font-family: 'DM Sans', sans-serif; font-weight: 600; font-size: clamp(12px, 2.5vw, 16px);
        color: #fff; line-height: 1.3; letter-spacing: 0.01em;
      }
      .card-clean .card-pub {
        font-family: 'DM Sans', sans-serif; font-weight: 300; font-size: clamp(9px, 1.8vw, 11px);
        color: rgba(255,255,255,0.55); margin-top: 6px; letter-spacing: 0.02em;
      }`,
    bold: `
      .card-bold { background: #111; }
      .card-bold img { filter: brightness(0.45); }
      .card-bold:hover img { filter: brightness(0.55); transform: scale(1.03); }
      .card-bold .overlay {
        display: flex; flex-direction: column; justify-content: flex-end;
        text-align: left; padding: 16px;
        background: linear-gradient(to top, rgba(0,0,0,0.6) 0%, transparent 60%);
      }
      .card-bold .card-title {
        font-family: 'DM Sans', sans-serif; font-weight: 700; font-size: clamp(11px, 2.4vw, 15px);
        color: #fff; text-transform: uppercase; letter-spacing: 0.05em; line-height: 1.25;
      }
      .card-bold .card-pub {
        font-family: 'DM Sans', sans-serif; font-weight: 400; font-size: clamp(8px, 1.6vw, 10px);
        color: rgba(255,255,255,0.45); margin-top: 5px; text-transform: uppercase; letter-spacing: 0.08em;
      }`,
    editorial: `
      .card-editorial { background: #1a1a1a; }
      .card-editorial img { filter: brightness(0.5) grayscale(20%); }
      .card-editorial:hover img { filter: brightness(0.6) grayscale(0%); transform: scale(1.03); }
      .card-editorial .overlay {
        display: flex; flex-direction: column; justify-content: flex-end;
        text-align: left; padding: 16px;
        background: linear-gradient(to top, rgba(0,0,0,0.5) 0%, transparent 55%);
      }
      .card-editorial .card-title {
        font-family: 'Fraunces', serif; font-weight: 400; font-size: clamp(13px, 2.8vw, 17px);
        font-style: italic; color: #fff; line-height: 1.3; letter-spacing: -0.01em;
      }
      .card-editorial .card-pub {
        font-family: 'DM Sans', sans-serif; font-weight: 400; font-size: clamp(8px, 1.6vw, 10px);
        color: rgba(255,255,255,0.4); margin-top: 5px; letter-spacing: 0.06em; text-transform: uppercase;
      }`
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(displayName)}</title>
  <meta property="og:title" content="${esc(displayName)}" />
  <meta property="og:description" content="Stories by ${esc(displayName)}" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500;9..40,600;9..40,700&family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,600;1,9..144,400&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { background: #fff; font-family: 'DM Sans', -apple-system, sans-serif; min-height: 100vh; -webkit-font-smoothing: antialiased; }

    header { display: flex; flex-direction: column; align-items: center; padding: 48px 24px 24px; gap: 14px; }
    .logo { width: clamp(140px, 40vw, 220px); height: auto; display: block; }
    .site-name { font-weight: 700; font-size: clamp(22px, 5vw, 32px); letter-spacing: -0.02em; color: #1a1a1a; }
    .subscribe-btn {
      display: inline-block; padding: 10px 24px;
      background: #1a1a1a; color: #fff;
      font-family: 'DM Sans', sans-serif; font-weight: 600; font-size: 13px;
      text-decoration: none; border-radius: 8px; transition: background 0.2s;
    }
    .subscribe-btn:hover { background: #333; }
    .instruction { font-weight: 300; font-size: 13px; color: #bbb; margin-top: 4px; }

    .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 3px; padding: 3px; margin-top: 8px; }
    .card { position: relative; aspect-ratio: 4/5; overflow: hidden; display: block; text-decoration: none; }
    .card img { width: 100%; height: 100%; object-fit: cover; display: block; transition: filter 0.4s ease, transform 0.5s ease; }
    .overlay { position: absolute; inset: 0; pointer-events: none; }

    ${styleCSS[style] || styleCSS.clean}

    footer { text-align: center; padding: 40px 24px; font-size: 11px; color: #ccc; letter-spacing: 0.04em; }
    footer a { color: #ccc; text-decoration: none; }
    footer a:hover { color: #999; }

    @media (max-width: 480px) { header { padding: 32px 16px 20px; } }
  </style>
</head>
<body>
  <header>
    ${header}
    <a class="subscribe-btn" href="${substackUrl}/subscribe" target="_blank" rel="noopener">Subscribe</a>
    <p class="instruction">Tap a story to read</p>
  </header>
  <main class="grid">
    ${cards}
  </main>
  <footer>
    Powered by <a href="/">stack.pub</a> &middot; Updated ${new Date(updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
  </footer>
</body>
</html>`;
}

function notFoundHTML(slug) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Not found</title>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;600&family=Fraunces:wght@600&display=swap" rel="stylesheet" />
  <style>body{font-family:'DM Sans',sans-serif;text-align:center;padding:4rem;color:#1a1a1a}h2{font-family:'Fraunces',serif;font-size:28px;margin-bottom:8px}p{font-size:15px;color:#666;margin-top:8px}a{color:#1a1a1a;font-weight:600}</style>
  </head><body>
  <h2>Page not found</h2>
  <p>No portfolio found for <strong>${slug}</strong>.</p>
  <p><a href="/">Create one at stack.pub</a></p>
  </body></html>`;
}

function esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`stackpub running on http://localhost:${PORT}`));
