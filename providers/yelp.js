// providers/yelp.js — Yelp Fusion API integration.
//
// Flow (official, ToS-compliant):
//   1. Business Search by location -> best-match business id
//   2. Business Reviews            -> rating, review_count, up to 3 excerpts
//
// Docs:
//   https://docs.developer.yelp.com/reference/v3_business_search
//   https://docs.developer.yelp.com/reference/v3_business_reviews
//
// LIMITS / CAVEATS:
//   - Yelp Fusion returns at most 3 review EXCERPTS per business (truncated
//     text) plus the aggregate rating and review_count. Full review text is
//     not available via the API.
//   - Matching a specific *residential* building to a Yelp business is
//     imperfect — Yelp indexes property-management companies and some
//     apartment complexes, not every address. We search near the address and
//     take the closest apartment/property listing; when nothing matches we
//     simply return null and the building shows Google + Radiator only.

const TOKEN = process.env.YELP_API_KEY;

async function getYelp(address) {
  if (process.env.MOCK === '1') return mockYelp(address);
  if (!TOKEN) return null;

  const headers = { Authorization: `Bearer ${TOKEN}` };

  // 1) Search near the address for an apartment / property listing
  const searchUrl =
    'https://api.yelp.com/v3/businesses/search' +
    `?location=${encodeURIComponent(address + ', Chicago, IL')}` +
    '&categories=apartments,homerental,propertymgmt&limit=1&radius=120';
  const sRes = await fetch(searchUrl, { headers });
  if (!sRes.ok) return null;
  const sJson = await sRes.json();
  const biz = sJson.businesses && sJson.businesses[0];
  if (!biz) return null;

  // 2) Fetch up to 3 review excerpts
  const revUrl = `https://api.yelp.com/v3/businesses/${biz.id}/reviews?limit=3&sort_by=yelp_sort`;
  const rRes = await fetch(revUrl, { headers });
  const rJson = rRes.ok ? await rRes.json() : { reviews: [] };

  return {
    source: 'yelp',
    name: biz.name || null,
    rating: typeof biz.rating === 'number' ? biz.rating : null,
    count: biz.review_count || 0,
    url: biz.url || null,
    reviews: (rJson.reviews || []).map((r) => ({
      author: r.user && r.user.name,
      rating: r.rating,
      text: r.text, // excerpt (truncated by Yelp)
      time: r.time_created, // ISO-ish string
      url: r.url,
    })),
  };
}

function mockYelp(address) {
  return {
    source: 'yelp',
    name: address + ' Apartments',
    rating: 3.5,
    count: 44,
    url: 'https://www.yelp.com/biz/example',
    reviews: [
      { author: 'Sam T.', rating: 4, text: 'Solid building, decent management, would rent again...', time: '2025-05-12T10:00:00', url: null },
      { author: 'Alex W.', rating: 2, text: 'Beautiful old place but repairs take forever...', time: '2025-02-01T09:00:00', url: null },
      { author: 'Priya N.', rating: 3, text: 'Fine for the price. Parking is the main headache...', time: '2024-11-20T14:00:00', url: null },
    ],
  };
}

module.exports = { getYelp };
