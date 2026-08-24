// providers/google.js — Google Places API integration.
//
// Flow (official, ToS-compliant):
//   1. Find Place From Text  -> resolve the address to a place_id
//   2. Place Details          -> rating, user_ratings_total, up to 5 reviews
//
// Docs:
//   https://developers.google.com/maps/documentation/places/web-service/search-find-place
//   https://developers.google.com/maps/documentation/places/web-service/details
//
// LIMIT: the Places API returns at most 5 review snippets per place. The
// aggregate rating + total count are complete; the full text of every review
// is NOT available through the official API (and scraping is not permitted).

const KEY = process.env.GOOGLE_PLACES_KEY;

async function getGoogle(address) {
  if (process.env.MOCK === '1') return mockGoogle(address);
  if (!KEY) return null; // not configured -> skip this source

  const query = `${address}, Chicago, IL`;

  // 1) Find Place
  const findUrl =
    'https://maps.googleapis.com/maps/api/place/findplacefromtext/json' +
    `?input=${encodeURIComponent(query)}` +
    '&inputtype=textquery&fields=place_id&key=' +
    KEY;
  const findRes = await fetch(findUrl);
  const findJson = await findRes.json();
  const placeId = findJson.candidates && findJson.candidates[0] && findJson.candidates[0].place_id;
  if (!placeId) return null;

  // 2) Place Details
  const detUrl =
    'https://maps.googleapis.com/maps/api/place/details/json' +
    `?place_id=${placeId}` +
    '&fields=name,rating,user_ratings_total,url,reviews&key=' +
    KEY;
  const detRes = await fetch(detUrl);
  const det = (await detRes.json()).result || {};

  return {
    source: 'google',
    name: det.name || null,
    rating: typeof det.rating === 'number' ? det.rating : null,
    count: det.user_ratings_total || 0,
    url: det.url || null,
    reviews: (det.reviews || []).map((r) => ({
      author: r.author_name,
      rating: r.rating,
      text: r.text,
      time: r.time, // unix seconds
      url: r.author_url || det.url,
    })),
  };
}

function mockGoogle(address) {
  return {
    source: 'google',
    name: address,
    rating: 4.1,
    count: 128,
    url: 'https://maps.google.com/?cid=example',
    reviews: [
      { author: 'Jordan P.', rating: 5, text: 'Management is responsive and the building is well kept.', time: 1719792000, url: null },
      { author: 'Mia R.', rating: 2, text: 'Heat was inconsistent last winter and repairs were slow.', time: 1707004800, url: null },
      { author: 'Devon K.', rating: 4, text: 'Great location, fair rent, quiet neighbors.', time: 1701820800, url: null },
    ],
  };
}

module.exports = { getGoogle };
