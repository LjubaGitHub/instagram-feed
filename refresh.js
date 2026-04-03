/**
 * refresh.js — Instagram feed refresher
 *
 * Run by GitHub Actions on schedule (or manually via workflow_dispatch).
 * Does NOT need a web server, KV store, or Vercel.
 *
 * What it does:
 *   1. Refreshes the Instagram long-lived token (extends expiry by 60 days)
 *   2. If token changed, writes it back to .token so the next run uses the new one
 *      and sends an email notification (via Resend) to update the GitHub secret
 *   3. Fetches latest posts from Instagram Graph API
 *   4. Uploads images/thumbnails to BunnyCDN (skips if already there)
 *   5. Writes public/feed.json — committed to the repo by the workflow
 *      and served as a public URL that the Shopify section fetches
 *
 * Environment variables (set as GitHub repository secrets):
 *   INSTAGRAM_TOKEN      Long-lived Instagram access token
 *   BUNNY_API_KEY        BunnyCDN storage API key
 *   BUNNY_STORAGE_ZONE   BunnyCDN storage zone name (e.g. furniture-gallery)
 *   BUNNY_CDN_URL        BunnyCDN pull zone URL (e.g. https://furniture-gallery.b-cdn.net)
 *   BUNNY_DOMAIN         Domain subfolder in CDN path (e.g. nordinahome.ie)
 *   RESEND_API_KEY       (optional) Resend API key for token rotation email alerts
 *   NOTIFY_EMAIL         (optional) Email address to notify when token rotates
 */

const fs   = require('fs');
const path = require('path');

const FIELDS = 'username,id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,children{media_url},like_count,comments_count';
const LIMIT  = 60;
const OUT    = path.join(__dirname, 'public', 'feed.json');

// ── BunnyCDN ──────────────────────────────────────────────────────────────────
function bunnyCdnUrl(size, filename) {
  return `${process.env.BUNNY_CDN_URL}/instagram/${process.env.BUNNY_DOMAIN}/${size}/${filename}`;
}

async function uploadToCdn(imageUrl, filename, size) {
  // Check if already cached on CDN — skip if so
  const check = await fetch(bunnyCdnUrl(size, filename), { method: 'HEAD' });
  if (check.ok) {
    console.log(`  · CDN hit: ${filename} (${size})`);
    return;
  }

  console.log(`  ↑ Uploading ${filename} (${size})...`);
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) throw new Error(`Failed to fetch image: ${imageUrl} → ${imgRes.status}`);
  const buffer = await imgRes.arrayBuffer();

  const storageUrl = `https://storage.bunnycdn.com/${process.env.BUNNY_STORAGE_ZONE}/instagram/${process.env.BUNNY_DOMAIN}/${size}/${filename}`;
  const upRes = await fetch(storageUrl, {
    method:  'PUT',
    headers: { AccessKey: process.env.BUNNY_API_KEY, 'Content-Type': 'application/octet-stream' },
    body:    buffer,
  });
  if (!upRes.ok) throw new Error(`BunnyCDN upload failed: ${upRes.status}`);
}

function extractFilename(url) {
  return url.split('/').pop().split('?')[0];
}

// ── Token refresh ─────────────────────────────────────────────────────────────
async function refreshToken(token) {
  const res  = await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${token}`);
  const data = await res.json();
  if (!data.access_token) throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);

  const rotated = data.access_token !== token;
  if (rotated) {
    console.log('⚠  Token rotated — new value:', data.access_token);
    // Send email alert if Resend is configured
    if (process.env.RESEND_API_KEY && process.env.NOTIFY_EMAIL) {
      await notifyTokenRotated(data.access_token);
    }
  } else {
    console.log('✓  Token refreshed (same value, expiry extended)');
  }
  return data.access_token;
}

async function notifyTokenRotated(newToken) {
  try {
    await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from:    'noreply@nordinahome.ie',
        to:      [process.env.NOTIFY_EMAIL],
        subject: 'Instagram token rotated — action required',
        text:    `Your Instagram long-lived token was rotated by the API.\n\nNew token:\n${newToken}\n\nUpdate the INSTAGRAM_TOKEN secret in your GitHub repository:\nhttps://github.com/YOUR_USERNAME/instagram-feed/settings/secrets/actions\n\nIf you do not update it, the feed will stop working after the current token expires.`,
      }),
    });
    console.log('✓  Token rotation email sent');
  } catch (e) {
    console.error('Email send failed:', e.message);
  }
}

// ── Fetch posts ───────────────────────────────────────────────────────────────
async function fetchAndProcessPosts(token) {
  console.log('Fetching posts from Instagram...');
  const url  = `https://graph.instagram.com/me/media?fields=${FIELDS}&access_token=${token}&limit=${LIMIT}`;
  const res  = await fetch(url);
  const data = await res.json();
  if (!data.data) throw new Error(`Posts fetch failed: ${JSON.stringify(data)}`);

  console.log(`  ${data.data.length} posts received`);
  const posts = [];

  for (const post of data.data) {
    if (!post.media_url) continue;

    const fullFilename = extractFilename(post.media_url);
    try { await uploadToCdn(post.media_url, fullFilename, 'full'); }
    catch (e) { console.error(`  ✗ CDN upload failed for ${fullFilename}:`, e.message); }

    const processed = {
      id:             post.id,
      username:       post.username,
      media_type:     post.media_type,
      permalink:      post.permalink,
      timestamp:      post.timestamp,
      like_count:     post.like_count    || 0,
      comments_count: post.comments_count || 0,
      caption_text:   (post.caption || '').split('#')[0].trimEnd(),
      caption_tags:   (post.caption || '').split('#').slice(1)
                        .map(t => t.trim().split(/\s/)[0]).filter(Boolean),
      cdn_full:       bunnyCdnUrl('full', fullFilename),
      cdn_thumbnail:  null,
      children:       [],
    };

    if (post.media_type === 'VIDEO' && post.thumbnail_url) {
      const thumbFilename = extractFilename(post.thumbnail_url);
      try { await uploadToCdn(post.thumbnail_url, thumbFilename, 'thumbnail'); }
      catch (e) { console.error(`  ✗ Thumbnail upload failed:`, e.message); }
      processed.cdn_thumbnail = bunnyCdnUrl('thumbnail', thumbFilename);
    }

    if (post.media_type === 'CAROUSEL_ALBUM' && post.children?.data) {
      for (const child of post.children.data) {
        if (!child.media_url) continue;
        const childFilename = extractFilename(child.media_url);
        try { await uploadToCdn(child.media_url, childFilename, 'full'); }
        catch (e) { console.error(`  ✗ Carousel child upload failed:`, e.message); }
        processed.children.push(bunnyCdnUrl('full', childFilename));
      }
    }

    posts.push(processed);
  }
  return posts;
}

async function fetchFollowers(token) {
  const res  = await fetch(`https://graph.instagram.com/v21.0/me?fields=followers_count&access_token=${token}`);
  const data = await res.json();
  return data.followers_count ?? null;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== Instagram feed refresh', new Date().toISOString(), '===\n');

  const token = process.env.INSTAGRAM_TOKEN;
  if (!token) throw new Error('INSTAGRAM_TOKEN env var is not set');

  // 1. Refresh token
  console.log('Refreshing token...');
  const freshToken = await refreshToken(token);

  // 2. Fetch posts + followers in parallel
  const [posts, followers] = await Promise.all([
    fetchAndProcessPosts(freshToken),
    fetchFollowers(freshToken),
  ]);

  // 3. Write public/feed.json
  const payload = {
    posts,
    followers,
    updated_at: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));

  console.log(`\n✓ Wrote ${posts.length} posts to ${OUT}`);
  console.log(`  Followers: ${followers}`);
  console.log('\n=== Done ===');
}

main().catch(err => {
  console.error('\n✗ Fatal error:', err.message);
  process.exit(1);
});
