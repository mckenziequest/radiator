// aggregate.js — pure, testable aggregation of reviews across sources.
//
// Each "source" object looks like:
//   { source: 'google'|'yelp'|'radiator', rating: Number(0-5)|null,
//     count: Number, url: String|null, reviews: [ { author, rating, text, time, url } ] }
//
// combine() produces a single unified object with:
//   - a COMBINED rating weighted by each source's review volume
//   - per-source breakdown
//   - a merged, de-duplicated, time-sorted review list
//   - a simple confidence signal based on total volume

// Weight each source by its review count, but dampen so one huge source
// doesn't completely bury a smaller, possibly more relevant one.
// weight = count ^ 0.75  (sub-linear). Tune DAMP to taste.
const DAMP = 0.75;

function sourceWeight(count) {
  const n = Math.max(0, Number(count) || 0);
  return Math.pow(n, DAMP);
}

function round1(x) {
  return Math.round(x * 10) / 10;
}

function combine(address, sources) {
  const clean = (sources || []).filter(
    (s) => s && typeof s.rating === 'number' && s.rating > 0 && (s.count || 0) > 0
  );

  // Weighted combined rating
  let wSum = 0;
  let rSum = 0;
  let totalCount = 0;
  for (const s of clean) {
    const w = sourceWeight(s.count);
    wSum += w;
    rSum += w * s.rating;
    totalCount += Number(s.count) || 0;
  }
  const combinedRating = wSum > 0 ? round1(rSum / wSum) : null;

  // Per-source breakdown (rounded, stable order)
  const order = { radiator: 0, google: 1, yelp: 2, reddit: 3, apartments: 4, facebook: 5 };
  const breakdown = (sources || [])
    .map((s) => ({
      source: s.source,
      rating: typeof s.rating === 'number' ? round1(s.rating) : null,
      count: Number(s.count) || 0,
      url: s.url || null,
    }))
    .sort((a, b) => (order[a.source] ?? 9) - (order[b.source] ?? 9));

  // Merge review excerpts, tag with source, sort newest first.
  const reviews = [];
  for (const s of sources || []) {
    for (const r of s.reviews || []) {
      reviews.push({
        source: s.source,
        author: r.author || 'Anonymous',
        rating: typeof r.rating === 'number' ? r.rating : null,
        text: (r.text || '').trim(),
        time: r.time || null, // ISO string or unix seconds
        url: r.url || s.url || null,
        score: typeof r.score === 'number' ? r.score : undefined, // reddit upvotes
        sentiment: r.sentiment || undefined, // reddit sentiment tag
      });
    }
  }
  reviews.sort((a, b) => toMs(b.time) - toMs(a.time));

  // Confidence: more total reviews across more sources => higher.
  const sourcesWithData = clean.length;
  let confidence = 'low';
  if (totalCount >= 25 && sourcesWithData >= 2) confidence = 'high';
  else if (totalCount >= 8) confidence = 'medium';

  return {
    address,
    combinedRating,
    totalReviews: totalCount,
    sourceCount: sourcesWithData,
    confidence,
    breakdown,
    reviews,
    generatedAt: new Date().toISOString(),
  };
}

function toMs(t) {
  if (!t) return 0;
  if (typeof t === 'number') return t < 1e12 ? t * 1000 : t; // unix sec vs ms
  const d = Date.parse(t);
  return isNaN(d) ? 0 : d;
}

module.exports = { combine, sourceWeight };
