require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

const stripe = Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_mock');

// ── Factory API (Bajie Charging / ChargeNow) ──────────────────────────
const FACTORY_BASE_URL = process.env.FACTORY_API_BASE_URL || 'https://developer.chargenow.top/cdb-open-api/v1';
const FACTORY_USERNAME = process.env.FACTORY_USERNAME || 'Joe';
const FACTORY_PASSWORD = process.env.FACTORY_PASSWORD || 'Joe@2026';
const CALLBACK_URL = process.env.CALLBACK_URL || 'http://localhost:3000/api/rent/callback';

// Axios instance with Basic Auth
const factoryApi = axios.create({
  baseURL: FACTORY_BASE_URL,
  auth: { username: FACTORY_USERNAME, password: FACTORY_PASSWORD },
  timeout: 15000,
});

// In-memory store for async rental callback results
const rentalResults = new Map();

// ── Known device IDs (from Factory API verification)
const REAL_DEVICES = {
  DTA55642: { shopId: '5c1e3a9ffd', shopName: ' Joe Shop', lat: 46.0095004, lng: 4.100983, online: true },
  DTA55645: { shopId: 'unknown', shopName: ' Joe Shop (Offline)', lat: 46.0120, lng: 4.0950, online: false },
};

// Map: shopId → deviceId (for enriching nearby API responses with device IDs)
const SHOP_DEVICE_MAP = { '5c1e3a9ffd': 'DTA55642' };

// ── Mock fallback data (France market) — used when Factory API returns no data
const MOCK_NEARBY = [
  { id: 'DTA55642', shopName: ' Joe Shop', lat: 46.0095004, lng: 4.100983, emptySlots: 2, rentableBatteries: 10, freeNum: 2, distance: '0.0 km', price: '1', deposit: '30', currency: 'EUR' },
  { id: 'DTA55645', shopName: ' Joe Shop (Offline)', lat: 46.0120, lng: 4.0950, emptySlots: 0, rentableBatteries: 0, freeNum: 0, distance: '0.5 km', price: '1', deposit: '30', currency: 'EUR' },
];

const MOCK_CABINET = {
  isRentable: true,
  availablePowerBanks: 10,
  emptyReturnSlots: 2,
  price: 1,
  currency: 'EUR',
  currencySymbol: '€',
  deposit: 30,
  freeMinutes: 10,
  dailyMaxPrice: 10,
  shopName: ' Joe Shop',
  cabinetId: 'DTA55642',
  isOnline: true,
  address: '24 Rue des Guérins, 42120 Le Coteau, 法国',
};

// ── 1. GET /api/nearby — List Nearby Rentable Shops (Factory: POST /rent/cabinet/list)
app.get('/api/nearby', async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat) || 46.0363;
    const lng = parseFloat(req.query.lng) || 4.0700;

    // Query the factory for a single cabinet by our known device ID
    const factoryRes = await factoryApi.get('/rent/cabinet/query', {
      params: { deviceId: 'DTA55642' },
    });

    if (factoryRes.data.code !== 0) {
      return res.json(MOCK_NEARBY);
    }

    const data = factoryRes.data.data;
    if (!data) throw new Error("No data from factory");

    const realLat = parseFloat(data.shop.latitude) || 46.009548411992746;
    const realLng = parseFloat(data.shop.longitude) || 4.101199421590414;

    // 1. Get total physical slots from the hardware spec
    const totalSlots = data.cabinet.slots;
    // 2. Count ACTUAL batteries inside by checking the batteries array length
    const actualBatteriesInside = data.batteries ? data.batteries.length : 0;
    // 3. Absolute truth: Empty holes = Total Slots - Batteries Inside
    const trueEmptyHoles = totalSlots - actualBatteriesInside;

    res.json([
      {
        id: 'DTA55642',
        lat: realLat,
        lng: realLng,
        emptySlots: trueEmptyHoles,
        rentableBatteries: actualBatteriesInside
      }
    ]);
  } catch (error) {
    res.json(MOCK_NEARBY);
  }
});

// ── 2. GET /api/cabinet/:id — Get Rentable Device and Pricing (Factory: GET /rent/cabinet/query)
app.get('/api/cabinet/:id', async (req, res) => {
  try {
    const response = await factoryApi.get('/rent/cabinet/query', {
      params: { deviceId: req.params.id },
    });

    if (response.data.code !== 0) {
      // Device offline or not found — return fallback with correct online status
      const isOffline = response.data.code === 2004;
      return res.json({
        ...MOCK_CABINET,
        cabinetId: req.params.id,
        isOnline: !isOffline,
        isRentable: !isOffline,
        availablePowerBanks: isOffline ? 0 : MOCK_CABINET.availablePowerBanks,
        message: response.data.msg || '',
      });
    }

    const data = response.data.data;
    if (!data) throw new Error("No data from factory");

    const totalSlots = data.cabinet.slots;
    const actualBatteriesInside = data.batteries ? data.batteries.length : 0;
    const trueEmptyHoles = totalSlots - actualBatteriesInside;

    res.json({
      isRentable: data.cabinet.isOnline && actualBatteriesInside > 0,
      availablePowerBanks: actualBatteriesInside,
      emptyReturnSlots: trueEmptyHoles,
      price: data.priceStrategy.price,
      currency: data.priceStrategy.currency,
      deposit: data.priceStrategy.depositAmount
    });
  } catch (error) {
    res.json({ ...MOCK_CABINET, cabinetId: req.params.id });
  }
});

// ── 2b. GET /pay/:deviceId — Redirect page that auto-launches Stripe Checkout (scan QR → this page → Stripe)
app.get('/pay/:deviceId', async (req, res) => {
  const deviceId = req.params.deviceId || 'DTA55642';
  const host = req.get('host') || 'powerbank-app-im73.onrender.com';
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  const baseUrl = `${proto}://${host}`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`
<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Paiement Location Batterie</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f0f9ff; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .card { background: white; border-radius: 24px; box-shadow: 0 20px 60px rgba(0,0,0,0.1); padding: 48px 40px; max-width: 420px; text-align: center; }
  .spinner { width: 56px; height: 56px; border: 5px solid #e0e7ff; border-top-color: #6366f1; border-radius: 50%; margin: 0 auto 24px; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  h1 { font-size: 24px; color: #1e3a8a; margin-bottom: 8px; }
  p { color: #64748b; line-height: 1.6; }
  .error { color: #dc2626; margin-top: 16px; }
  .btn { display: inline-block; background: #6366f1; color: white; text-decoration: none; padding: 14px 32px; border-radius: 12px; font-weight: 700; font-size: 16px; margin-top: 20px; }
</style>
</head>
<body>
  <div class="card">
    <div class="spinner"></div>
    <h1>Préparation du paiement...</h1>
    <p>Station: ${deviceId}</p>
    <p>Redirection vers Stripe en cours</p>
    <p id="err" class="error" style="display:none;"></p>
    <a id="retry" href="" class="btn" style="display:none;">Réessayer</a>
  </div>
  <script>
    (async function() {
      try {
        const resp = await fetch('${baseUrl}/api/rent/checkout-link?deviceId=${deviceId}');
        const data = await resp.json();
        if (data.url) {
          window.location.href = data.url;
        } else {
          throw new Error(data.error || 'Pas d URL de paiement');
        }
      } catch(e) {
        document.getElementById('err').textContent = 'Erreur: ' + e.message;
        document.getElementById('err').style.display = 'block';
        document.querySelector('.spinner').style.display = 'none';
        document.getElementById('retry').style.display = 'inline-block';
      }
    })();
  </script>
</body>
</html>
  `);
});

// ── 3. POST /api/rent/preauth — Stripe Pre-authorization (€30 Hold)
app.post('/api/rent/preauth', async (req, res) => {
  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: 3000,
      currency: 'eur',
      automatic_payment_methods: { enabled: true }, // Updated for new Stripe API
      capture_method: 'manual',
    });
    res.json({ clientSecret: paymentIntent.client_secret, paymentIntentId: paymentIntent.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── 3b. GET /api/rent/checkout-link — Stripe Checkout Session (no registration, direct payment)
app.get('/api/rent/checkout-link', async (req, res) => {
  const deviceId = req.query.deviceId || 'DTA55642';
  const host = req.get('host') || 'powerbank-app-im73.onrender.com';
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  const baseUrl = `${proto}://${host}`;
  try {
    const session = await stripe.checkout.sessions.create({
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
            name: 'Power Bank Rental — Caution (DTA55642)',
            description: `Pré-autorisation de 30€ pour la location de batterie. Device: ${deviceId}`,
          },
          unit_amount: 3000,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${baseUrl}/payment/success?deviceId=${deviceId}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/payment/cancel?deviceId=${deviceId}`,
      metadata: { deviceId },
    });
    res.json({ url: session.url, sessionId: session.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── 3c. GET /payment/success — Simple HTML success page (no frontend needed)
app.get('/payment/success', (req, res) => {
  const deviceId = req.query.deviceId || 'DTA55642';
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`
<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Paiement Réussi</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f0fdf4; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .card { background: white; border-radius: 24px; box-shadow: 0 20px 60px rgba(0,0,0,0.1); padding: 48px 40px; max-width: 420px; text-align: center; }
  .check { width: 80px; height: 80px; background: #22c55e; border-radius: 50%; margin: 0 auto 24px; display: flex; align-items: center; justify-content: center; font-size: 48px; color: white; }
  h1 { font-size: 28px; color: #166534; margin-bottom: 12px; }
  p { color: #4b5563; line-height: 1.6; margin-bottom: 8px; }
  .device { display: inline-block; background: #dcfce7; color: #166534; padding: 4px 12px; border-radius: 8px; font-weight: 600; font-size: 14px; margin: 8px 0 24px; }
  .info { background: #f0f9ff; border: 1px solid #bae6fd; border-radius: 12px; padding: 16px; margin: 20px 0; }
  .info p { font-size: 14px; color: #0369a1; }
  .btn { display: inline-block; background: #22c55e; color: white; text-decoration: none; padding: 14px 32px; border-radius: 12px; font-weight: 700; font-size: 16px; margin-top: 16px; }
</style>
</head>
<body>
  <div class="card">
    <div class="check">&#10003;</div>
    <h1>Paiement Réussi !</h1>
    <p>Votre pré-autorisation de 30€ a été acceptée.</p>
    <span class="device">Station: ${deviceId}</span>
    <div class="info">
      <p>🔒 La batterie est en cours de déverrouillage...</p>
      <p>Veuillez retirer la batterie dans les 30 secondes.</p>
    </div>
    <p style="font-size:13px;color:#9ca3af;">Si la batterie ne sort pas, contactez le support avec l'ID: ${deviceId}</p>
    <a href="https://powerbank-relleup5y-joe-shop.vercel.app" class="btn">Retour à la carte</a>
  </div>
</body>
</html>
  `);
});

// ── 3d. GET /payment/cancel — Simple HTML cancel page
app.get('/payment/cancel', (req, res) => {
  const deviceId = req.query.deviceId || 'DTA55642';
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`
<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Paiement Annulé</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #fef2f2; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .card { background: white; border-radius: 24px; box-shadow: 0 20px 60px rgba(0,0,0,0.1); padding: 48px 40px; max-width: 420px; text-align: center; }
  .cross { width: 80px; height: 80px; background: #ef4444; border-radius: 50%; margin: 0 auto 24px; display: flex; align-items: center; justify-content: center; font-size: 48px; color: white; }
  h1 { font-size: 28px; color: #991b1b; margin-bottom: 12px; }
  p { color: #4b5563; line-height: 1.6; margin-bottom: 8px; }
  .btn { display: inline-block; background: #3b82f6; color: white; text-decoration: none; padding: 14px 32px; border-radius: 12px; font-weight: 700; font-size: 16px; margin-top: 16px; }
</style>
</head>
<body>
  <div class="card">
    <div class="cross">&#10005;</div>
    <h1>Paiement Annulé</h1>
    <p>Vous avez annulé le paiement. Aucun montant n'a été débité.</p>
    <p style="font-size:13px;color:#9ca3af;margin-top:12px;">Station: ${deviceId}</p>
    <a href="https://powerbank-relleup5y-joe-shop.vercel.app" class="btn">Réessayer</a>
  </div>
</body>
</html>
  `);
});

// ── 4. POST /api/rent/eject — Create a Rental Order (Factory: POST /rent/order/create)
app.post('/api/rent/eject', async (req, res) => {
  const { deviceId, paymentIntentId } = req.body;
  try {
    const response = await factoryApi.post('/rent/order/create', null, {
      params: {
        deviceId,
        callbackURL: CALLBACK_URL,
      },
    });

    if (response.data.code !== 0) {
      // Factory rejected the order — instantly release the Stripe hold
      if (paymentIntentId) await stripe.paymentIntents.cancel(paymentIntentId);
      return res.status(400).json({
        success: false,
        message: 'Échec du déverrouillage, caution annulée: ' + response.data.msg,
      });
    }

    const tradeNo = response.data.data?.tradeNo;
    res.json({
      success: true,
      tradeNo,
      message: 'Commande créée, déverrouillage en cours...',
    });
  } catch (error) {
    if (paymentIntentId) await stripe.paymentIntents.cancel(paymentIntentId);
    res.status(500).json({ error: 'System error, caution released: ' + error.message });
  }
});

// ── 5. POST /api/rent/status — Query Rental Order Status (Factory: POST /rent/order/query)
app.post('/api/rent/status', async (req, res) => {
  const { tradeNo } = req.body;
  try {
    const response = await factoryApi.post('/rent/order/query', null, {
      params: { tradeNo },
    });

    const success = response.data.code === 0;
    res.json({
      success,
      code: response.data.code,
      message: response.data.msg,
      callbackResult: rentalResults.get(tradeNo) || null,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── 6. GET /api/rent/detail — Get Rental Order Details (Factory: GET /rent/order/detail)
app.get('/api/rent/detail', async (req, res) => {
  const { tradeNo } = req.query;
  try {
    const response = await factoryApi.get('/rent/order/detail', {
      params: { tradeNo },
    });

    if (response.data.code !== 0) {
      return res.status(400).json({ error: response.data.msg });
    }

    res.json(response.data.data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── 7. POST /api/rent/callback — Async callback receiver (Factory pushes rental results)
app.post('/api/rent/callback', (req, res) => {
  const { tradeNo, ...rest } = req.body;
  if (tradeNo) {
    rentalResults.set(tradeNo, { ...rest, timestamp: Date.now() });
  }
  res.json({ code: 0, msg: 'success' });
});

// ── 8. POST /api/rent/cancel-hold — Cancel a Stripe payment hold (used on rental timeout)
app.post('/api/rent/cancel-hold', async (req, res) => {
  const { paymentIntentId } = req.body;
  try {
    if (paymentIntentId) {
      await stripe.paymentIntents.cancel(paymentIntentId);
    }
    res.json({ success: true, message: 'Caution libérée' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
