// test.js — unit-tests the aggregation logic (no network, no keys).
const assert = require('assert');
const { combine, sourceWeight } = require('./aggregate');
const { isBuildingResidentialCandidate, addressMatches } = require('./providers/google');

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

// --- venue filtering: a building's Google reviews must be about the RESIDENCE,
//     never a co-located bar, brokerage, hotel, shop, etc. (regression for the
//     "2206 N California Ave is a music venue" bug). Safe failure: ambiguous ->
//     reject (no Google rating is better than the wrong one). ---
const place = (types, name) => ({ types, name: name || '' });
// NEGATIVE — must be rejected as a building review source:
assert.strictEqual(isBuildingResidentialCandidate(place(['bar', 'point_of_interest', 'establishment'], 'The Owl')), false, 'bar rejected');
assert.strictEqual(isBuildingResidentialCandidate(place(['night_club', 'establishment', 'food'], 'Concord Music Hall')), false, 'music venue rejected');
assert.strictEqual(isBuildingResidentialCandidate(place(['restaurant', 'food', 'point_of_interest'], 'Lula Cafe')), false, 'restaurant rejected');
assert.strictEqual(isBuildingResidentialCandidate(place(['store', 'establishment'], 'Corner Store')), false, 'retail store rejected');
assert.strictEqual(isBuildingResidentialCandidate(place(['church', 'place_of_worship'], 'St. Mary')), false, 'church rejected');
assert.strictEqual(isBuildingResidentialCandidate(place(['lodging', 'point_of_interest', 'establishment'], 'The Robey Hotel')), false, 'hotel (lodging) rejected');
assert.strictEqual(isBuildingResidentialCandidate(place(['real_estate_agency', 'point_of_interest', 'establishment'], 'Fulton Grace Realty')), false, 'brokerage / real_estate_agency rejected');
// property-management OFFICE typed generic but named like a management co:
assert.strictEqual(isBuildingResidentialCandidate(place(['point_of_interest', 'establishment'], 'Pangea Property Management')), false, 'management office (by name) rejected');
assert.strictEqual(isBuildingResidentialCandidate(place(['point_of_interest', 'establishment'], 'Smith & Co Brokerage')), false, 'brokerage (by name) rejected');
// POSITIVE — genuine residences kept:
assert.strictEqual(isBuildingResidentialCandidate(place(['apartment_complex', 'point_of_interest', 'establishment'], 'Grand Plaza')), true, 'apartment_complex kept');
assert.strictEqual(isBuildingResidentialCandidate(place(['premise'], '')), true, 'plain address point kept');
assert.strictEqual(isBuildingResidentialCandidate(place(['point_of_interest', 'establishment'], 'Presidential Towers')), true, 'residential name kept');
assert.strictEqual(isBuildingResidentialCandidate(place(['point_of_interest', 'establishment'], '540 W Addison Apartments')), true, 'named apartments kept');
// Ambiguity / empties -> reject (safe failure):
assert.strictEqual(isBuildingResidentialCandidate(place([], 'Somewhere')), false, 'no types -> rejected (safe failure)');
assert.strictEqual(isBuildingResidentialCandidate(place(['bar', 'apartment_complex'], 'Mixed Use')), true, 'strong residential type still wins if explicitly apartment');

// --- address matching: same street number is NOT enough; the street name must
//     match too, and a suite/office at the address is not the building. ---
assert.strictEqual(addressMatches('2206 N California Ave, Chicago, IL 60647, USA', '2206 N California Ave'), true, 'exact address matches');
assert.strictEqual(addressMatches('2206 W Chicago Ave, Chicago, IL', '2206 N California Ave'), false, 'same number, different street rejected');
assert.strictEqual(addressMatches('540 N State St, Chicago, IL', '1900 N Austin Ave'), false, 'different number rejected');
assert.strictEqual(addressMatches('2206 N California Ave Ste 3, Chicago, IL', '2206 N California Ave'), true, 'suite at same address still matches street+number');
assert.strictEqual(addressMatches('', '2206 N California Ave'), false, 'empty candidate rejected');

console.log('ALL AGGREGATION TESTS PASSED');
