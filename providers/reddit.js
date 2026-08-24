// providers/reddit.js — Reddit mentions via the official Reddit API.
//
// Reddit isn't a star-rating site — it's discussion. So this returns matched
// posts/comments as "mentions" (rating: null) with upvotes and a rough
// sentiment tag. They show up in Radiator's unified review list and feed the
// discussion view, but do NOT distort the numeric star score.
//
// Auth: application-only OAuth (client_credentials).
//   1. POST https://www.reddit.com/api/v1/access_token  (Basic client_id:secret)
//   2. GET  https://oauth.reddit.com/r/<subs>/search    (Bearer token + User-Agent)
// Docs: https://www.reddit.com/dev/api  +  https://github.com/reddit-archive/reddit/wiki/OAuth2
//
// Env: REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USER_AGENT (required by Reddit).

const CLIENT_ID = process.env.REDDIT_CLIENT_ID;
const CLIENT_SECRET = process.env.REDDIT_CLIENT_SECRET;
const UA = process.env.REDDIT_USER_AGENT || 'web:radiator:v1.0 (Chicago rental reviews)';
const SUBS = process.env.REDDIT_SUBS || 'chicago+chicagoapartments+LoganSquare+uptown+rogerspark';

let tokenCache = { token: null, exp: 0 };

async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.exp) return tokenCache.token;
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error('reddit auth ' + res.status);
  const j = await res.json();
  tokenCache = { token: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  return tokenCache.token;
}

// tiny sentiment lexicon — approximate on purpose, and labeled as such in the UI
const POS = ['great', 'love', 'good', 'responsive', 'clean', 'quiet', 'recommend', 'best', 'nice', 'warm', 'fixed', 'helpful', 'safe'];
const NEG = ['avoid', 'terrible', 'awful', 'cold', 'broken', 'roach', 'rats', 'mice', 'bed bug', 'bedbug', 'ignore', 'ignored', 'slumlord', 'deposit', 'never', 'worst', 'leak', 'mold', 'eviction', 'scam', 'unresponsive'];
function sentiment(text) {
  const t = (text || '').toLowerCase();
  let p = 0, n = 0;
  for (const w of POS) if (t.includes(w)) p++;
  for (const w of NEG) if (t.includes(w)) n++;
  if (p === 0 && n === 0) return 'neutral';
  if (p > n * 1.5) return 'positive';
  if (n > p * 1.5) return 'negative';
  return 'mixed';
}

async function getReddit(address) {
  if (process.env.MOCK === '1') return mockReddit(address);
  if (!CLIENT_ID || !CLIENT_SECRET) return null;

  const token = await getToken();
  // Search the address (and its street, for recall) within Chicago subs.
  const street = address.replace(/^\d+\s+/, ''); // drop leading house number for a looser match
  const q = `"${address}" OR "${street}"`;
  const url =
    `https://oauth.reddit.com/r/${SUBS}/search` +
    `?q=${encodeURIComponent(q)}&restrict_sr=1&limit=12&sort=relevance&type=link`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'User-Agent': UA } });
  if (!res.ok) return null;
  const j = await res.json();
  const children = (j.data && j.data.children) || [];

  const reviews = children
    .map((c) => c.data)
    .filter((d) => d && (d.title || d.selftext))
    .map((d) => {
      const text = (d.title + (d.selftext ? ' — ' + d.selftext : '')).slice(0, 400);
      return {
        author: 'u/' + (d.author || 'unknown') + ' · r/' + d.subreddit,
        rating: null, // discussion, not a rating
        text,
        time: d.created_utc, // unix seconds
        url: 'https://reddit.com' + d.permalink,
        score: d.ups, // upvotes
        sentiment: sentiment(text),
      };
    });

  if (!reviews.length) return null;
  return { source: 'reddit', name: null, rating: null, count: reviews.length, url: `https://www.reddit.com/r/chicago/search?q=${encodeURIComponent(q)}`, reviews };
}

function mockReddit(address) {
  const reviews = [
    { author: 'u/renter773 · r/chicago', rating: null, text: `Anyone live near ${address}? Heard mixed things about the management there.`, time: 1717000000, url: 'https://reddit.com/r/chicago/x', score: 34, sentiment: 'mixed' },
    { author: 'u/loganresident · r/chicagoapartments', rating: null, text: `Avoid ${address} — cold all winter and they ignored repair requests.`, time: 1707000000, url: 'https://reddit.com/r/chicagoapartments/y', score: 51, sentiment: 'negative' },
  ];
  return { source: 'reddit', name: null, rating: null, count: reviews.length, url: 'https://www.reddit.com/r/chicago', reviews };
}

module.exports = { getReddit };
