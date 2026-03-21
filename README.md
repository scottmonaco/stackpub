# stack.pub

Visual portfolio pages for Substack writers. Paste your Substack URL, choose a grid style, get a permanent link.

## What it does

A writer visits stack.pub, enters their Substack publication URL, and gets a permanent portfolio page at `stack.pub/theirname` — a photo grid of all their posts, newest first, each image linking to the story with UTM tracking. Updates automatically when they publish.

## Features

- **Full URL input** — paste `https://yourname.substack.com` or a custom domain
- **Cover photo mode** — uses the uploaded hero image from each post
- **Title card mode** — dark overlay with post title for an editorial feel
- **Auto logo detection** — pulls publication logo from the feed
- **UTM tracking** — every link back to Substack includes `utm_source=stackpub` parameters
- **Automatic updates** — grid refreshes from the RSS feed on each visit

## Deploy to Vercel (no terminal needed)

### Step 1: Create the GitHub repo
1. Go to github.com and click **New repository**
2. Name it `stackpub`, set to Public, click **Create repository**
3. Upload all files from this folder using the **Add file → Upload files** button
4. Make sure the folder structure is: `api/index.js`, `public/index.html`, `package.json`, `vercel.json` at the root

### Step 2: Connect to Vercel
1. Go to [vercel.com](https://vercel.com) and sign up with your GitHub account (free)
2. Click **Add New → Project**
3. Find and select your `stackpub` repo
4. Click **Deploy** — accept all defaults
5. Your app is live at the URL Vercel gives you

### Step 3: Custom domain (optional)
1. In your Vercel project settings, go to **Domains**
2. Add `stack.pub` (or whatever domain you own)
3. Update your DNS records as Vercel instructs

## File structure

```
stackpub/
├── api/
│   └── index.js          # Server — fetches RSS feeds, renders portfolio pages
├── public/
│   └── index.html         # Homepage with signup form
├── package.json
├── vercel.json            # Vercel routing config
└── README.md
```

## Data storage note

The prototype stores pages in memory — they reset when the serverless function cold-starts. For production, swap the `pages` object for Vercel KV (free tier) or Supabase. Quick upgrade once the concept is validated.
