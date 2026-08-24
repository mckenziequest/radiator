// test.js — unit-tests the aggregation logic (no network, no keys).
const assert = require('assert');
const { combine, sourceWeight } = require('./aggregate');

// weighted combine: volume-weighted, sub-linear
const sources = [
  { source: 'google', rating: 4.1, count: 128, reviews: [{ author: 'A', rating: 5, text: 'good', time: 1719792000 }] },
  { source: 'yelp', rating: 3.5, count: 44, reviews: [{ author: 'B', rating: 2, text: 'meh', time: '2025-05-12T10:00:00' }] },
  { source: 'radiator', rating: 4.8, count: 3, reviews: [] },
];
const out = combine('1600 N Damen Ave', sources);

console.log('combinedRating:', out.combinedRating, '| total:', out.totalReviews, '| conf:', out.confidence);
assert(out.combinedRating > 3.5 && out.combinedRating < 4.2, 'combined should sit between the big sources');
assert.strictEqual(out.totalReviews, 175);
assert.strictEqual(out.confidence, 'high');
assert.strictEqual(out.breakdown[0].source, 'radiator'); // stable order
assert.strictEqual(out.reviews.length, 2); // merged excerpts
assert.strictEqual(out.reviews[0].source, 'yelp'); // 2025 newer than 2024 google unix

// no sources -> null rating, low confidence
const empty = combine('nowhere', []);
assert.strictEqual(empty.combinedRating, null);
assert.strictEqual(empty.confidence, 'low');

// sub-linear weighting: doubling count does NOT double weight
assert(sourceWeight(200) < 2 * sourceWeight(100));

console.log('ALL AGGREGATION TESTS PASSED');
