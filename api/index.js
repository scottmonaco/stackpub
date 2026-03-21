const express = require('express');
const fetch = require('node-fetch');
const xml2js = require('xml2js');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const pages = {};

function parseSubstackUrl(input) {
  let clean = input.trim().toLowerCase();
  if (!clean.includes('.') && !clean.includes('/')) return clean;
  clean = clean.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const substackMatch = clean.match(/^([a-z0-9_-]+)\.substack\.com/);
  if (substackMatch) return substackMatch[1];
  return clean.split('/')[0];
}

async function fetchFeedPage(baseUrl, page) {
  const url = page > 1 ? `${baseUrl}?page=${page}` : baseUrl;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; stackpub/1.0)' },
      redirect: 'follow',
      timeout: 15000
    });
    if (!res.ok) return null;
    const xml = await res.text();
    if (!xml.includes('<rss')) return null;
    const parsed = await xml2js.parseStringPromise(xml, { explicitArray: false });
    const channel = parsed.rss.channel;
    const items = Array.isArray(channel.item) ? channel.item : channel.item ? [channel.item] : [];
    return { channel, items };
  } catch (e) {
    return null;
  }
}

async function fetchSubstackFeed(publication) {
  const baseUrls = [
    `https://${publication}.substack.com/feed`,
    `https://${publication}/feed`
  ];

  let lastError;
  for (const baseUrl of baseUrls) {
    try {
      // Fetch page 1 first
      const first = await fetchFeedPage(baseUrl, 1);
      if (!first || first.items.length === 0) continue;

      const channelMeta = first.channel;
      let allItems = [...first.items];
      let seenLinks = new Set(first.items.map(i => i.link || ''));
      const firstPageCount = first.items.length;

      // Only attempt pagination if page 1 returned a full page (likely more exist)
      if (firstPageCount >= 10) {
        // Fetch remaining pages in parallel batches for speed
        // First try pages 2-5 simultaneously
        let page = 2;
        let keepGoing = true;
        const maxPages = 30;

        while (keepGoing && page <= maxPages) {
          // Fetch up to 3 pages at a time for speed
          const batch = [];
          for (let i = 0; i < 3 && page + i <= maxPages; i++) {
            batch.push(fetchFeedPage(baseUrl, page + i));
          }
          const results = await Promise.all(batch);

          let batchHadNew = false;
          for (const result of results) {
            if (!result || result.items.length === 0) {
              keepGoing = false;
              break;
            }
            let pageHadNew = false;
            for (const item of result.items) {
              const link = item.link || '';
              if (link && !seenLinks.has(link)) {
                seenLinks.add(link);
                allItems.push(item);
                pageHadNew = true;
                batchHadNew = true;
              }
            }
            if (!pageHadNew) {
              keepGoing = false;
              break;
            }
          }
          if (!batchHadNew) keepGoing = false;
          page += batch.length;
        }
      }

      const posts = allItems.map(item => {
        const title = item.title || '';
        const link = item.link || '';

        let img = '';
        if (item.enclosure && item.enclosure.$ && item.enclosure.$.url) {
          const mimeType = item.enclosure.$.type || '';
          if (mimeType.startsWith('image/') || (!mimeType && item.enclosure.$.url.match(/\.(jpg|jpeg|png|webp|gif)/i))) {
            img = item.enclosure.$.url;
          }
        }
        if (!img && item['media:content']) {
          const media = item['media:content'];
          if (media.$ && media.$.url) {
            const mimeType = media.$.type || '';
            if (!mimeType.startsWith('video/') && !mimeType.startsWith('audio/')) {
              img = media.$.url;
            }
          }
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

      const name = channelMeta.title || publication;
      const logo = channelMeta.image?.url || '';
      const substackUrl = channelMeta.link || `https://${publication}.substack.com`;

      return { name, logo, substackUrl, posts };
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(lastError?.message || `Could not fetch feed for "${publication}"`);
}

app.post('/api/register', async (req, res) => {
  const { substackUrl, displayName, logoUrl, imageStyle, excludeNoImage } = req.body;
  if (!substackUrl) return res.status(400).json({ error: 'Publication URL is required' });

  const slug = parseSubstackUrl(substackUrl);
  if (!slug) return res.status(400).json({ error: 'Could not parse that URL' });

  try {
    const feed = await fetchSubstackFeed(slug);
    let posts = feed.posts;
    if (excludeNoImage) posts = posts.filter(p => p.img);

    pages[slug] = {
      slug,
      displayName: displayName || feed.name || slug,
      logoUrl: logoUrl || feed.logo || '',
      imageStyle: imageStyle || 'broadsheet',
      excludeNoImage: !!excludeNoImage,
      substackUrl: feed.substackUrl,
      posts,
      totalFetched: feed.posts.length,
      updatedAt: new Date().toISOString()
    };
    res.json({
      ok: true, url: `/${slug}`,
      postCount: posts.length,
      totalFetched: feed.posts.length,
      excluded: feed.posts.length - posts.length
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/refresh/:slug', async (req, res) => {
  const slug = req.params.slug;
  if (!pages[slug]) return res.status(404).json({ error: 'Page not found' });
  try {
    const feed = await fetchSubstackFeed(slug);
    let posts = feed.posts;
    if (pages[slug].excludeNoImage) posts = posts.filter(p => p.img);
    pages[slug].posts = posts;
    pages[slug].updatedAt = new Date().toISOString();
    res.json({ ok: true, postCount: posts.length });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.get('/:slug', (req, res) => {
  const slug = req.params.slug.toLowerCase();
  if (slug === 'api' || slug === 'favicon.ico') return res.status(404).end();
  const page = pages[slug];
  if (!page) return res.status(404).send(notFoundHTML(slug));
  res.send(renderPage(page));
});

const styleFonts = {
  broadsheet: {
    import: "family=Bricolage+Grotesque:wght@700;800&family=DM+Sans:opsz,wght@9..40,400;9..40,600",
    title: "'Bricolage Grotesque', sans-serif",
    body: "'DM Sans', sans-serif"
  },
  byline: {
    import: "family=Newsreader:ital,wght@0,600;1,400&family=DM+Sans:opsz,wght@9..40,400;9..40,600",
    title: "'Newsreader', serif",
    body: "'DM Sans', sans-serif"
  },
  billboard: {
    import: "family=Bebas+Neue&family=DM+Sans:opsz,wght@9..40,400;9..40,600",
    title: "'Bebas Neue', sans-serif",
    body: "'DM Sans', sans-serif"
  }
};

function renderPage({ slug, displayName, logoUrl, imageStyle, substackUrl, posts, updatedAt }) {
  const header = logoUrl
    ? `<img class="logo" src="${logoUrl}" alt="${esc(displayName)}" />\n    <div class="site-name sub">${esc(displayName)}</div>`
    : `<div class="site-name">${esc(displayName)}</div>`;

  const style = imageStyle || 'broadsheet';
  const fonts = styleFonts[style] || styleFonts.broadsheet;

  const cards = posts.map(p => {
    const imgTag = p.img
      ? `<img src="${p.img}" alt="${esc(p.title)}" loading="lazy" onerror="this.style.display='none'" />`
      : '';
    return `
    <a class="card" href="${p.link}" target="_blank" rel="noopener">
      ${imgTag}
      <div class="overlay">
        <span class="card-title">${esc(p.title)}</span>
      </div>
    </a>`;
  }).join('\n');

  const styleCSS = {
    broadsheet: `
      .card { background: #1a1a1a; }
      .card img { filter: brightness(0.65) saturate(0.9); }
      .card:hover img, .card:active img { filter: brightness(0.9) saturate(1.1); transform: scale(1.03); }
      .card .overlay {
        display: flex; align-items: flex-end;
        text-align: left; padding: 14px;
        background: linear-gradient(to top, rgba(0,0,0,0.6) 0%, rgba(0,0,0,0.1) 40%, transparent 100%);
      }
      .card .card-title {
        font-family: ${fonts.title}; font-weight: 800;
        font-size: clamp(16px, 4.5vw, 26px);
        color: #fff; line-height: 1.1;
        text-shadow: 0 1px 4px rgba(0,0,0,0.4);
      }`,
    byline: `
      .card { background: #1a1a1a; }
      .card img { filter: brightness(0.65) saturate(0.9); }
      .card:hover img, .card:active img { filter: brightness(0.9) saturate(1.1); transform: scale(1.03); }
      .card .overlay {
        display: flex; align-items: flex-end;
        text-align: left; padding: 14px;
        background: linear-gradient(to top, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.08) 40%, transparent 100%);
      }
      .card .card-title {
        font-family: ${fonts.title}; font-weight: 400;
        font-size: clamp(16px, 4.5vw, 26px);
        font-style: italic; color: #fff; line-height: 1.1;
        text-shadow: 0 1px 4px rgba(0,0,0,0.4);
      }`,
    billboard: `
      .card { background: #0a0a0a; }
      .card img { filter: brightness(0.6) saturate(0.9); }
      .card:hover img, .card:active img { filter: brightness(0.85) saturate(1.1); transform: scale(1.03); }
      .card .overlay {
        display: flex; align-items: center; justify-content: center;
        text-align: center; padding: 14px;
        background: rgba(0,0,0,0.2);
      }
      .card .card-title {
        font-family: ${fonts.title}; font-weight: 400;
        font-size: clamp(22px, 6.5vw, 38px);
        color: #fff; text-transform: uppercase; line-height: 0.95; letter-spacing: 0.04em;
        text-shadow: 0 2px 8px rgba(0,0,0,0.5);
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
  <link href="https://fonts.googleapis.com/css2?${fonts.import}&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { background: #fff; font-family: ${fonts.body}; min-height: 100vh; -webkit-font-smoothing: antialiased; }

    header { display: flex; flex-direction: column; align-items: center; padding: 40px 24px 20px; gap: 8px; }
    .logo { width: clamp(80px, 20vw, 120px); height: auto; display: block; }
    .site-name { font-weight: 700; font-size: clamp(22px, 5vw, 32px); letter-spacing: -0.02em; color: #1a1a1a; }
    .site-name.sub { font-size: clamp(13px, 2.8vw, 16px); font-weight: 400; color: #888; letter-spacing: 0.02em; margin-top: -4px; }
    .subscribe-btn {
      display: inline-block; padding: 9px 22px; margin-top: 4px;
      background: #1a1a1a; color: #fff;
      font-family: ${fonts.body}; font-weight: 600; font-size: 12px;
      text-decoration: none; border-radius: 6px; transition: background 0.2s;
    }
    .subscribe-btn:hover { background: #333; }
    .instruction { font-weight: 300; font-size: 12px; color: #ccc; margin-top: 2px; }

    .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 2px; padding: 2px; margin-top: 6px; }
    .card { position: relative; aspect-ratio: 9/16; overflow: hidden; display: block; text-decoration: none; }
    .card img { width: 100%; height: 100%; object-fit: cover; display: block; transition: filter 0.4s ease, transform 0.5s ease; }
    .overlay { position: absolute; inset: 0; pointer-events: none; }

    ${styleCSS[style] || styleCSS.broadsheet}

    footer { text-align: center; padding: 36px 24px; font-size: 11px; color: #ccc; letter-spacing: 0.04em; }
    footer a { color: #ccc; text-decoration: none; }
    footer a:hover { color: #999; }

    @media (max-width: 480px) { header { padding: 28px 16px 16px; } }
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
    Powered by <a href="/">stack.pub</a> &middot; ${posts.length} stories &middot; Updated ${new Date(updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
  </footer>
</body>
</html>`;
}

function notFoundHTML(slug) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Not found</title>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;600&display=swap" rel="stylesheet" />
  <style>body{font-family:'DM Sans',sans-serif;text-align:center;padding:4rem;color:#1a1a1a}h2{font-size:28px;font-weight:700;margin-bottom:8px}p{font-size:15px;color:#666;margin-top:8px}a{color:#1a1a1a;font-weight:600}</style>
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
