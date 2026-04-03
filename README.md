# Instagram Feed Refresher

Runs daily via GitHub Actions. Fetches posts from Instagram, uploads media
to BunnyCDN, and commits `public/feed.json` to this repo.

The Shopify section fetches `public/feed.json` directly from GitHub's raw
content CDN (fast, globally cached).

## Feed URL

```
https://raw.githubusercontent.com/YOUR_USERNAME/instagram-feed/main/public/feed.json
```

## Setup

See the setup instructions in the project documentation.

## Manual refresh

Go to Actions → Refresh Instagram Feed → Run workflow
