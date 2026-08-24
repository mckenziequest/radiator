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

// A street address can also be a bar, restaurant, music venue, shop, church, a
// leasing/brokerage office, or a hotel. Those places carry Google reviews about
// drinks / shows / service / a stay — NOT about renting or living in the
// building. Attaching them would put a nightclub's reviews (and party photos),
// or a management company's service reviews, on a rental listing.
//
// We therefore accept a Google Place as a *building* review source only when it
// reads as a residence, and we bias hard toward SAFE FAILURE: when a candidate
// is ambiguous, we reject it and show no Google rating rather than the wrong one.

// Types that UNAMBIGUOUSLY mark a residence we can attach building reviews to.
const STRONG_RESIDENTIAL_TYPES = new Set(['apartment_complex', 'apartment_building']);

// Types whose reviews are NOT about living in the building. Note this now
// includes `real_estate_agency` (a brokerage / leasing / property-management
// OFFICE — its reviews belong on a FIRM profile, not a building) and `lodging`
// (a hotel — not an apartment). A strong-residential type overrides these; a
// generic address point does not.
const DISALLOWED_TYPES = new Set([
  'bar', 'night_club', 'restaurant', 'cafe', 'food', 'meal_takeaway',
  'meal_delivery', 'liquor_store', 'bakery', 'movie_theater', 'casino',
  'bowling_alley', 'stadium', 'tourist_attraction', 'amusement_park',
  'art_gallery', 'museum', 'gym', 'spa', 'beauty_salon', 'hair_care',
  'store', 'clothing_store', 'shoe_store', 'book_store', 'furniture_store',
  'convenience_store', 'supermarket', 'shopping_mall', 'gas_station',
  'car_repair', 'car_dealer', 'church', 'place_of_worship', 'school',
  'university', 'hospital', 'pharmacy', 'doctor', 'dentist', 'bank', 'atm',
  'lawyer', 'insurance_agency', 'accounting', 'library', 'park', 'zoo',
  'aquarium', 'storage', 'moving_company',
  'real_estate_agency', 'lodging', // brokerage / leasing office & hotel — belong elsewhere
]);

// Name tokens that betray a non-residential business even when Google's types
// are generic (only point_of_interest/establishment).
const VENUE_NAME_RE = /\b(bar|grill|tavern|pub|lounge|club|hall|theat(?:re|er)|cantina|brewery|taproom|winery|distillery|cafe|coffee|restaurant|kitchen|pizzeria|diner|hotel|inn|motel|hostel|church|temple|mosque|synagogue|school|academy|university|college|salon|spa|gym|fitness|market|deli|bakery|realty|realtors?|brokerage|property management|management|leasing|law|attorney|dental|dentist|clinic|pharmacy|bank|credit union|museum|gallery|storage)\b/i;
// Name tokens that reinforce a residence.
const RESIDENTIAL_NAME_RE = /\b(apartments?|residences?|lofts?|towers?|flats?|commons|manor|terrace|gardens?|courts?|the\s+\w+)\b/i;
// The only types allowed for a place whose name is neutral (no residential and
// no venue signal): a plain address point with no business meaning.
const GENERIC_OK = new Set(['premise', 'subpremise', 'point_of_interest', 'establishment', 'street_address', 'geocode', 'route']);

// Decide whether a Google Place is a building we can attach reviews to.
// Multi-signal — types are authoritative, then name, then a strong-residential
// override. Anything ambiguous resolves to REJECT.
function isBuildingResidentialCandidate(place) {
  const types = Array.isArray(place && place.types) ? place.types : [];
  const name = String((place && place.name) || '');
  if (types.some((t) => STRONG_RESIDENTIAL_TYPES.has(t))) return true; // apartment_complex etc.
  if (types.some((t) => DISALLOWED_TYPES.has(t))) return false;        // bar / office / hotel / shop
  if (VENUE_NAME_RE.test(name)) return false;                          // business name gives it away
  if (RESIDENTIAL_NAME_RE.test(name)) return true;                     // "…Apartments/Towers/Lofts"
  // Neutral name: only accept a bare address point with no business type at all.
  return types.length > 0 && types.every((t) => GENERIC_OK.has(t));
}

// Leading street number, e.g. "540 N State St" -> "540". (declared above)
// Significant street-name tokens: drop the number, directionals, street-type
// suffixes, unit markers, and city/state. "2206 N California Ave, Chicago, IL"
// -> ["california"].
const ADDR_STOPWORDS = new Set([
  'n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw', 'north', 'south', 'east', 'west',
  'st', 'street', 'ave', 'avenue', 'blvd', 'boulevard', 'rd', 'road', 'dr',
  'drive', 'ln', 'lane', 'ct', 'court', 'pl', 'place', 'ter', 'terrace',
  'pkwy', 'parkway', 'hwy', 'way', 'sq', 'square', 'cir', 'circle',
  'chicago', 'il', 'illinois', 'usa', 'ste', 'suite', 'unit', 'apt', 'fl', 'floor', '#',
]);
function streetTokens(addr) {
  return String(addr || '').toLowerCase()
    .replace(/[.,]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !/^\d+$/.test(t) && !ADDR_STOPWORDS.has(t));
}

// The candidate's own address must carry the SAME street number AND at least one
// of the query's street-name tokens — so "2206 N California Ave" never matches a
// rated place at "2206 W Chicago Ave" (same number, different street).
function addressMatches(candidateAddr, queryAddr) {
  const num = streetNumber(queryAddr);
  if (!num) return false;
  const ca = String(candidateAddr || '').toLowerCase();
  if (!new RegExp('(^|\\D)' + num + '(\\D|$)').test(ca)) return false;
  const qt = streetTokens(queryAddr);
  if (!qt.length) return true; // nothing to compare on → number is enough
  return qt.some((t) => ca.includes(t));
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

  // Keep only rated listings that read as a residence (not a bar/venue/shop/
  // office/hotel), so a rental listing never inherits the wrong reviews.
  const eligible = (json.results || []).filter(
    (r) =>
      typeof r.rating === 'number' &&
      r.user_ratings_total > 0 &&
      isBuildingResidentialCandidate(r)
  );
  if (!eligible.length) return null;

  // The chosen place must actually BE this address — same street number AND the
  // same street name. No loose "strongest nearby result" fallback: a wrong
  // Google rating is worse than none, so ambiguity returns null.
  const top = eligible.find((r) => addressMatches(r.formatted_address || r.vicinity, address)) || null;
  if (!top) return null;

  // Place Details for a few review snippets + photo references (best effort).
  let reviews = [];
  let photoRefs = [];
  let placeUrl = 'https://www.google.com/maps/place/?q=place_id:' + top.place_id;
  try {
    const detUrl =
      'https://maps.googleapis.com/maps/api/place/details/json' +
      '?place_id=' + top.place_id +
      '&fields=url,reviews,photos&key=' + KEY;
    const det = (await (await fetch(detUrl)).json()).result || {};
    if (det.url) placeUrl = det.url;
    reviews = (det.reviews || []).map((r) => ({
      author: r.author_name,
      rating: r.rating,
      text: r.text,
      time: r.time,
      url: r.author_url || det.url,
    }));
    // Keep just the opaque photo references; the API key is applied later,
    // server-side, by the /api/photo proxy so it is never exposed to clients.
    photoRefs = (det.photos || []).slice(0, 6).map((p) => p.photo_reference).filter(Boolean);
  } catch (e) { /* details are optional */ }

  return {
    source: 'google',
    name: top.name || null,
    rating: top.rating,
    count: top.user_ratings_total || 0,
    url: placeUrl,
    reviews,
    photoRefs,
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

module.exports = { getGoogle, isBuildingResidentialCandidate, addressMatches };
