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

function getBaseUrls(publication) {
  if (publication.includes('.')) return [`https://${publication}`];
  return [`https://${publication}.substack.com`];
}

async function fetchViaAPI(publication) {
  const baseUrls = getBaseUrls(publication);
  let lastError;

  for (const baseUrl of baseUrls) {
    try {
      let allPosts = [];
      let offset = 0;
      const limit = 50;
      const maxPosts = 500;

      while (offset < maxPosts) {
        const url = `${baseUrl}/api/v1/archive?sort=new&limit=${limit}&offset=${offset}`;
        const res = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; stackpub/1.0)' },
          timeout: 8000
        });
        if (!res.ok) throw new Error('API not available');
        const data = await res.json();
        if (!Array.isArray(data) || data.length === 0) break;

        for (const post of data) {
          const title = post.title || '';
          const slug = post.slug || '';
          const link = `${baseUrl}/p/${slug}`;
          const img = post.cover_image || '';
          const postType = post.type || 'newsletter';
          const isArticle = (postType === 'newsletter' || postType === 'thread');

          if (title && slug) {
            const utmLink = `${link}?utm_source=stackpub&utm_medium=portfolio&utm_campaign=grid`;
            allPosts.push({ title, link: utmLink, img, isArticle });
          }
        }

        if (data.length < limit) break;
        offset += limit;
      }

      if (allPosts.length === 0) continue;

      // Fetch publication metadata (name, logo)
      let name = publication;
      let logo = '';
      let substackUrl = baseUrl;
      try {
        const metaRes = await fetch(`${baseUrl}/api/v1/publication`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; stackpub/1.0)' },
          timeout: 5000
        });
        if (metaRes.ok) {
          const meta = await metaRes.json();
          name = meta.name || publication;
          logo = meta.logo_url || meta.logo_url_small || '';
          if (meta.custom_domain) substackUrl = `https://${meta.custom_domain}`;
        }
      } catch (e) { /* use defaults */ }

      return { name, logo, substackUrl, posts: allPosts };
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error('API not available');
}

async function fetchViaRSS(publication) {
  const isCustomDomain = publication.includes('.');
  const urls = isCustomDomain
    ? [`https://${publication}/feed`]
    : [`https://${publication}.substack.com/feed`];

  let lastError;
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; stackpub/1.0)' },
        redirect: 'follow',
        timeout: 8000
      });
      if (!res.ok) throw new Error(`Could not fetch feed for "${publication}"`);
      const xml = await res.text();
      if (!xml.includes('<rss')) throw new Error('Invalid RSS feed');

      const parsed = await xml2js.parseStringPromise(xml, { explicitArray: false });
      const channel = parsed.rss.channel;
      const items = Array.isArray(channel.item) ? channel.item : channel.item ? [channel.item] : [];

      const posts = items.map(item => {
        const title = item.title || '';
        const link = item.link || '';
        let img = '';
        let isArticle = true;

        if (item.enclosure && item.enclosure.$ && item.enclosure.$.type) {
          const mt = item.enclosure.$.type;
          if (mt.startsWith('video/') || mt.startsWith('audio/')) isArticle = false;
        }
        if (item.enclosure && item.enclosure.$ && item.enclosure.$.url) {
          const mt = item.enclosure.$.type || '';
          if (mt.startsWith('image/') || (!mt && item.enclosure.$.url.match(/\.(jpg|jpeg|png|webp|gif)/i))) {
            img = item.enclosure.$.url;
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
        return { title, link: utmLink, img, isArticle };
      }).filter(p => p.title && p.link);

      const name = channel.title || publication;
      const logo = channel.image?.url || '';
      const substackUrl = channel.link || `https://${publication}${isCustomDomain ? '' : '.substack.com'}`;
      return { name, logo, substackUrl, posts };
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error(`Could not fetch feed for "${publication}"`);
}

async function fetchSubstackFeed(publication) {
  try {
    const result = await fetchViaAPI(publication);
    if (result.posts.length > 0) return result;
  } catch (e) { /* API failed, try RSS */ }
  return await fetchViaRSS(publication);
}

app.post('/api/register', async (req, res) => {
  const { substackUrl, displayName, logoUrl, imageStyle, excludeNoImage } = req.body;
  if (!substackUrl) return res.status(400).json({ error: 'Publication URL is required' });

  const slug = parseSubstackUrl(substackUrl);
  if (!slug) return res.status(400).json({ error: 'Could not parse that URL' });

  try {
    const feed = await fetchSubstackFeed(slug);
    let posts = feed.posts;
    if (excludeNoImage) posts = posts.filter(p => p.img && p.isArticle !== false);

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
    if (pages[slug].excludeNoImage) posts = posts.filter(p => p.img && p.isArticle !== false);
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
    import: "family=Syne:wght@600;700&family=DM+Sans:opsz,wght@9..40,400;9..40,600",
    title: "'Syne', sans-serif",
    body: "'DM Sans', sans-serif"
  },
  byline: {
    import: "family=Newsreader:ital,wght@1,400;1,500&family=DM+Sans:opsz,wght@9..40,400;9..40,600",
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
  // Logo + name underneath if logo exists; just name big if not
  let header;
  if (logoUrl) {
    header = `<img class="logo" src="${logoUrl}" alt="${esc(displayName)}" />\n    <div class="site-name sub">${esc(displayName)}</div>`;
  } else {
    header = `<div class="site-name">${esc(displayName)}</div>`;
  }

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
      .card .overlay {
        display: flex; align-items: flex-start;
        text-align: left; padding: 7cqi;
        background: linear-gradient(to bottom, rgba(0,0,0,0.62) 0%, rgba(0,0,0,0.35) 25%, rgba(0,0,0,0.12) 50%, transparent 100%);
      }
      .card .card-title {
        font-family: ${fonts.title}; font-weight: 600;
        font-size: 8.5cqi;
        color: #fff; line-height: 1.1; letter-spacing: -0.01em;
        text-shadow: 0 1px 3px rgba(0,0,0,0.7), 0 2px 10px rgba(0,0,0,0.5), 0 0 24px rgba(0,0,0,0.3);
      }`,
    byline: `
      .card .overlay {
        display: flex; flex-direction: column; align-items: center; justify-content: flex-end;
        text-align: center; padding: 7cqi;
        background: linear-gradient(to top, rgba(0,0,0,0.62) 0%, rgba(0,0,0,0.35) 25%, rgba(0,0,0,0.12) 50%, transparent 100%);
      }
      .card .card-title {
        font-family: ${fonts.title}; font-weight: 400;
        font-size: 12cqi;
        font-style: italic; color: #fff; line-height: 1.1;
        text-shadow: 0 1px 3px rgba(0,0,0,0.7), 0 2px 10px rgba(0,0,0,0.5), 0 0 24px rgba(0,0,0,0.3);
      }`,
    billboard: `
      .card .overlay {
        display: flex; align-items: center; justify-content: center;
        text-align: center; padding: 6cqi;
        background: rgba(0,0,0,0.18);
      }
      .card .card-title {
        font-family: ${fonts.title}; font-weight: 400;
        font-size: 18cqi;
        color: rgba(255,255,255,0.75);
        text-transform: uppercase; line-height: 0.92; letter-spacing: 0.03em;
        text-shadow: 0 2px 6px rgba(0,0,0,0.6), 0 0 28px rgba(0,0,0,0.35);
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

    header { display: flex; flex-direction: column; align-items: center; padding: 44px 24px 22px; gap: 10px; }
    .logo { width: clamp(160px, 42vw, 280px); height: auto; display: block; }
    .site-name { font-weight: 700; font-size: clamp(24px, 5vw, 36px); letter-spacing: -0.02em; color: #1a1a1a; text-align: center; }
    .site-name.sub { font-size: clamp(14px, 3vw, 18px); font-weight: 400; color: #888; letter-spacing: 0.02em; margin-top: -4px; }
    .subscribe-btn {
      display: inline-block; padding: 11px 30px; margin-top: 6px;
      background: #1a1a1a; color: #fff;
      font-family: ${fonts.body}; font-weight: 600; font-size: 14px;
      text-decoration: none; border-radius: 6px; transition: background 0.2s;
    }
    .subscribe-btn:hover { background: #333; }
    .instruction { font-weight: 300; font-size: 13px; color: #ccc; margin-top: 4px; }

    .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 2px; padding: 2px; margin-top: 10px; }
    .card {
      position: relative; aspect-ratio: 3/4; overflow: hidden;
      display: block; text-decoration: none; background: #1a1a1a;
      container-type: inline-size;
    }
    .card img {
      width: 100%; height: 100%; object-fit: cover; display: block;
      filter: brightness(0.62) saturate(0.9);
      transition: filter 0.4s ease, transform 0.5s ease;
    }
    .card:hover img, .card:active img {
      filter: brightness(0.88) saturate(1.1); transform: scale(1.03);
    }
    .overlay { position: absolute; inset: 0; pointer-events: none; }

    ${styleCSS[style] || styleCSS.broadsheet}

    footer { text-align: center; padding: 36px 24px; font-size: 11px; color: #ccc; letter-spacing: 0.04em; }
    footer a { color: #ccc; text-decoration: none; }
    footer a:hover { color: #999; }
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
