// providers/google.js — Google Places API integration.
//
// Resolving a plain street address to the right listing is the tricky part:
//   • "540 N State St, Chicago, IL"            -> the address POINT (no rating)
//   • "540 N State St apartments Chicago IL"    -> "Grand Plaza" 3.8 (62 reviews)
// Biasing the Text Search toward apartments is what surfaces the building's
// review listing instead of a bare map pin. We then guard against grabbing a
// *nearby* apartment by requiring the result's own address to carry the same
// street number as the building we asked about.
//
// Docs:
//   https://developers.google.com/maps/documentation/places/web-service/search-text
//   https://developers.google.com/maps/documentation/places/web-service/details

const KEY = process.env.GOOGLE_PLACES_KEY;

// Leading street number of an address, e.g. "540 N State St" -> "540".
function streetNumber(addr) {
  const m = String(addr || '').trim().match(/^(\d+)/);
  return m ? m[1] : null;
}

async function getGoogle(address) {
  if (process.env.MOCK === '1') return mockGoogle(address);
  if (!KEY) return null; // not configured -> skip this source

  // Normalize whatever the caller passed to just the street portion, so the
  // query is clean whether the address arrived as "737 W Washington Blvd" or
  // "737 W Washington Blvd, Chicago, IL 60661, USA".
  const street = String(address)
    .split(',')[0]
    .replace(/\b(chicago|illinois|il|usa)\b/gi, '')
    .replace(/\b\d{5}(-\d{4})?\b/g, '')
    .trim();

  // Bias toward the apartment/building listing (which carries the reviews)
  // rather than the raw street-address point.
  const query = `${street} apartments Chicago IL`;

  const url =
    'https://maps.googleapis.com/maps/api/place/textsearch/json' +
    '?query=' + encodeURIComponent(query) +
    '&key=' + KEY;

  let json;
  try {
    const res = await fetch(url);
    json = await res.json();
  } catch (e) {
    console.error('GOOGLE textsearch fetch failed:', e.message);
    return null;
  }

  if (json.status !== 'OK' && json.status !== 'ZERO_RESULTS') {
    console.error('GOOGLE textsearch status:', json.status, '| msg:', json.error_message || '(none)');
    return null;
  }

  // Only listings that actually carry a rating are useful to us.
  const rated = (json.results || []).filter(
    (r) => typeof r.rating === 'number' && r.user_ratings_total > 0
  );
  if (!rated.length) return null;

  // Guard against a nearby-but-wrong apartment: prefer a rated listing whose
  // own formatted address begins with the same street number we searched for.
  const num = streetNumber(address);
  let top = null;
  if (num) {
    top = rated.find((r) => {
      const fa = String(r.formatted_address || r.vicinity || '');
      // match the number as a standalone token at the start of the address
      return new RegExp('(^|\\b)' + num + '\\b').test(fa);
    });
  }
  // Fall back to the strongest rated result only when nothing matched by number
  // AND the top result is clearly a building (many ratings), to avoid noise.
  if (!top) {
    const strong = rated[0];
    if (strong && strong.user_ratings_total >= 15) top = strong;
  }
  if (!top) return null;

  // Place Details for a few review snippets (best effort).
  let reviews = [];
  let placeUrl = 'https://www.google.com/maps/place/?q=place_id:' + top.place_id;
  try {
    const detUrl =
      'https://maps.googleapis.com/maps/api/place/details/json' +
      '?place_id=' + top.place_id +
      '&fields=url,reviews&key=' + KEY;
    const det = (await (await fetch(detUrl)).json()).result || {};
    if (det.url) placeUrl = det.url;
    reviews = (det.reviews || []).map((r) => ({
      author: r.author_name,
      rating: r.rating,
      text: r.text,
      time: r.time,
      url: r.author_url || det.url,
    }));
  } catch (e) { /* details are optional */ }

  return {
    source: 'google',
    name: top.name || null,
    rating: top.rating,
    count: top.user_ratings_total || 0,
    url: placeUrl,
    reviews,
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
