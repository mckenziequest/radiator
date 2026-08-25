// payments.js — Stripe Checkout for Radiator's access passes.
//
// Payments are OFF by default and require BOTH an explicit opt-in flag AND a
// Stripe secret to turn on:
//     PAYMENTS_ENABLED=1   AND   STRIPE_SECRET_KEY present
// A Stripe secret ALONE never enables checkout (so a secret can stay stored in
// production while checkout stays dormant), and the flag ALONE never enables it
// either. Only both together initialize the Stripe client and expose checkout;
// with payments disabled Stripe is never require()'d/initialized, so NO Stripe
// network request is ever made. No webhooks and no product setup needed: prices
// are defined inline here, and access is granted by verifying the completed
// Checkout Session when Stripe redirects the buyer back.

const PLANS = {
  pass:    { label: 'Day pass',        amount: 999,  days: 1 },
  quarter: { label: '3-month access',  amount: 1999, days: 90 },
  renter:  { label: 'Renter — 1 year', amount: 7900, days: 365, renter: true },
};

function origin(req) { return (req.headers['x-forwarded-proto'] || 'https') + '://' + (req.headers.host || ''); }

function mount(app) {
  // Both the opt-in flag AND a secret are required. Stripe is only require()'d
  // when both are present, so nothing initializes (and no network call can
  // happen) while payments are disabled — even if the secret is stored.
  const enabled = process.env.PAYMENTS_ENABLED === '1';
  const key = process.env.STRIPE_SECRET_KEY;
  const stripe = (enabled && key) ? require('stripe')(key) : null;
  if (stripe) console.log('Stripe payments ENABLED (PAYMENTS_ENABLED=1 + STRIPE_SECRET_KEY).');
  else console.log('Stripe payments disabled (needs BOTH PAYMENTS_ENABLED=1 and STRIPE_SECRET_KEY; a secret alone does nothing).');

  // Frontend asks whether real checkout is available.
  app.get('/api/payments/status', (_req, res) => res.json({ enabled: !!stripe }));

  // Start a Checkout Session for a plan → returns the Stripe-hosted URL to redirect to.
  app.post('/api/checkout', async (req, res) => {
    if (!stripe) return res.status(503).json({ error: 'Payments are not set up yet.' });
    const planKey = (req.body || {}).plan;
    const plan = PLANS[planKey];
    if (!plan) return res.status(400).json({ error: 'Unknown plan.' });
    const o = origin(req);
    try {
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: [{
          price_data: {
            currency: 'usd',
            product_data: { name: 'Radiator — ' + plan.label, description: 'Full access to every Chicago tenant review.' },
            unit_amount: plan.amount,
          },
          quantity: 1,
        }],
        success_url: o + '/?paid=' + planKey + '&session_id={CHECKOUT_SESSION_ID}',
        cancel_url: o + '/?checkout=cancel',
        metadata: { plan: planKey },
        allow_promotion_codes: true,
      });
      res.json({ url: session.url });
    } catch (e) {
      console.error('stripe checkout error:', e.message);
      res.status(500).json({ error: 'Could not start checkout.' });
    }
  });

  // After Stripe redirects back, the app verifies the session server-side before granting access.
  app.get('/api/checkout/verify', async (req, res) => {
    if (!stripe) return res.json({ ok: false });
    try {
      const s = await stripe.checkout.sessions.retrieve(String(req.query.session_id || ''));
      if (s && s.payment_status === 'paid') {
        const plan = (s.metadata && s.metadata.plan) || '';
        const p = PLANS[plan] || {};
        return res.json({ ok: true, plan, days: p.days || 0, renter: !!p.renter });
      }
      res.json({ ok: false });
    } catch (e) { res.json({ ok: false }); }
  });
}

module.exports = { mount, PLANS };
