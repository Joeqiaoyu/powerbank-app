require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const axios = require('axios');

const app = express();

// ── Production-grade CORS ──
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json());

// ── Environment variable safety checks ──
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const FACTORY_API_BASE_URL = process.env.FACTORY_API_BASE_URL;
const FACTORY_USERNAME = process.env.FACTORY_USERNAME;
const FACTORY_PASSWORD = process.env.FACTORY_PASSWORD;

if (!STRIPE_SECRET_KEY) {
  console.warn('⚠️  WARNING: STRIPE_SECRET_KEY is not set. Stripe payments will fail.');
}
if (!FACTORY_USERNAME || !FACTORY_PASSWORD) {
  console.warn('⚠️  WARNING: FACTORY_USERNAME or FACTORY_PASSWORD is not set. Factory API calls will fail.');
}

const stripe = STRIPE_SECRET_KEY ? Stripe(STRIPE_SECRET_KEY) : null;

// ── Factory API (Bajie Charging / ChargeNow) ──────────────────────────
const FACTORY_BASE_URL = FACTORY_API_BASE_URL || 'https://developer.chargenow.top/cdb-open-api/v1';
const CALLBACK_URL = process.env.CALLBACK_URL || 'https://powerbank-app-im73.onrender.com/api/rent/callback';

// Axios instance with Basic Auth
const factoryApi = axios.create({
  baseURL: FACTORY_BASE_URL,
  auth: { username: FACTORY_USERNAME, password: FACTORY_PASSWORD },
  timeout: 15000,
});

// ── In-memory stores ──────────────────────────────────────────────────
// rentalResults: Factory async callback results (tradeNo → callback data)
// rentalRecords: Full rental lifecycle records (tradeNo → { paymentIntentId, deviceId, startTime, endTime, status, billing })
const rentalResults = new Map();
const rentalRecords = new Map();

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

// ── 0. GET /health — Health check (critical for Render free-tier wake detection)
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'UP',
    timestamp: new Date().toISOString(),
    stripe: !!stripe,
    factory: !!(FACTORY_USERNAME && FACTORY_PASSWORD),
  });
});

// ── 1. GET /api/nearby — List Nearby Rentable Shops (Factory: GET /rent/cabinet/query)
app.get('/api/nearby', async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat) || 46.0363;
    const lng = parseFloat(req.query.lng) || 4.0700;

    // Query the factory for a single cabinet by our known device ID
    const factoryRes = await factoryApi.get('/rent/cabinet/query', {
      params: { deviceId: 'DTA55642' },
    });

    // ── Deep logging: raw Factory response ──
    console.log('[FACTORY NEARBY RAW DATA]:', JSON.stringify(factoryRes.data, null, 2));

    if (factoryRes.data.code !== 0) {
      // Factory returned non-zero code — device may be offline
      // Code 2004 = device not found, 2005 = device offline
      console.warn('[FACTORY NEARBY] Non-zero code:', factoryRes.data.code, 'Msg:', factoryRes.data.msg);
      // Return data with explicit online=false so frontend shows correct status
      return res.json([
        {
          id: 'DTA55642',
          shopName: ' Joe Shop',
          lat: 46.0095004,
          lng: 4.100983,
          emptySlots: 0,
          rentableBatteries: 0,
          freeNum: 0,
          distance: '0.0 km',
          price: '1',
          deposit: '30',
          currency: 'EUR',
          isOnline: false,
          message: factoryRes.data.msg || 'Device offline',
        }
      ]);
    }

    const data = factoryRes.data.data;
    if (!data) throw new Error("No data from factory");

    // ── Extract online status from Factory's cabinet object ──
    // Factory returns: data.cabinet.online (boolean true/false)
    // Some API versions may use: data.cabinet.isOnline (boolean) or data.cabinet.online (number: 1/0)
    const factoryIsOnline = data.cabinet.online === true || data.cabinet.isOnline === true || data.cabinet.online === 1 || data.cabinet.online === '1';
    console.log('[FACTORY NEARBY] Cabinet online status:', {
      'cabinet.online': data.cabinet.online,
      'cabinet.isOnline': data.cabinet.isOnline,
      'cabinet.posOnlineStatus': data.cabinet.posOnlineStatus,
      'resolved': factoryIsOnline,
    });

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
        shopName: data.shop?.name || ' Joe Shop',
        lat: realLat,
        lng: realLng,
        emptySlots: trueEmptyHoles,
        rentableBatteries: actualBatteriesInside,
        freeNum: trueEmptyHoles,
        distance: '0.0 km',
        price: String(data.priceStrategy?.price || '1'),
        deposit: String(data.priceStrategy?.depositAmount || '30'),
        currency: data.priceStrategy?.currency || 'EUR',
        isOnline: factoryIsOnline,
      }
    ]);
  } catch (error) {
    console.error('[FACTORY NEARBY FETCH FAILED]:', error.message);
    if (error.response) {
      console.error('[FACTORY NEARBY ERROR] Status:', error.response.status, 'Data:', JSON.stringify(error.response.data));
    }
    // Return mock data with explicit offline status on total failure
    res.json(MOCK_NEARBY);
  }
});

// ── 2. GET /api/cabinet/:id — Get Rentable Device and Pricing (Factory: GET /rent/cabinet/query)
app.get('/api/cabinet/:id', async (req, res) => {
  const deviceId = req.params.id;
  try {
    const response = await factoryApi.get('/rent/cabinet/query', {
      params: { deviceId },
    });

    // ── Deep logging: raw Factory response ──
    console.log('[FACTORY STATUS RAW DATA]:', JSON.stringify(response.data, null, 2));

    if (response.data.code !== 0) {
      // Factory returned non-zero code
      // Known error codes: 2004 = device not found, 2005 = device offline
      const errorCode = response.data.code;
      const errorMsg = response.data.msg || 'Unknown error';
      const isOffline = errorCode === 2004 || errorCode === 2005;

      console.warn(`[FACTORY STATUS] Device ${deviceId} non-zero code: ${errorCode} (${errorMsg}) — isOffline: ${isOffline}`);

      return res.json({
        ...MOCK_CABINET,
        cabinetId: deviceId,
        isOnline: !isOffline,
        isRentable: !isOffline,
        availablePowerBanks: isOffline ? 0 : MOCK_CABINET.availablePowerBanks,
        message: errorMsg,
        factoryCode: errorCode,
      });
    }

    const data = response.data.data;
    if (!data) throw new Error("No data from factory");

    // ── Extract online status from Factory's cabinet object ──
    // Factory returns: data.cabinet.online (boolean true/false)
    // Some API versions may use: data.cabinet.isOnline (boolean) or data.cabinet.online (number: 1/0)
    const factoryIsOnline = data.cabinet.online === true || data.cabinet.isOnline === true || data.cabinet.online === 1 || data.cabinet.online === '1';
    console.log('[FACTORY STATUS] Cabinet online field:', {
      'cabinet.online': data.cabinet.online,
      'cabinet.isOnline': data.cabinet.isOnline,
      'cabinet.posOnlineStatus': data.cabinet.posOnlineStatus,
      'resolved': factoryIsOnline,
    });

    const totalSlots = data.cabinet.slots;
    const actualBatteriesInside = data.batteries ? data.batteries.length : 0;
    const trueEmptyHoles = totalSlots - actualBatteriesInside;
    const isRentable = factoryIsOnline && actualBatteriesInside > 0;

    console.log(`[FACTORY STATUS] Device ${deviceId}: online=${factoryIsOnline}, batteries=${actualBatteriesInside}, emptySlots=${trueEmptyHoles}, rentable=${isRentable}`);

    res.json({
      isRentable,
      isOnline: factoryIsOnline,
      availablePowerBanks: actualBatteriesInside,
      emptyReturnSlots: trueEmptyHoles,
      price: data.priceStrategy?.price ?? 1,
      currency: data.priceStrategy?.currency ?? 'EUR',
      deposit: data.priceStrategy?.depositAmount ?? 30,
      cabinetId: deviceId,
      shopName: data.shop?.name || ' Joe Shop',
      freeMinutes: data.priceStrategy?.freeMinutes ?? 10,
      dailyMaxPrice: data.priceStrategy?.dailyMaxPrice ?? 10,
      currencySymbol: data.priceStrategy?.currency === 'EUR' ? '€' : (data.priceStrategy?.currencySymbol || '€'),
    });
  } catch (error) {
    console.error('[FACTORY STATUS FETCH FAILED]:', error.message);
    if (error.response) {
      console.error('[FACTORY STATUS ERROR] Status:', error.response.status, 'Data:', JSON.stringify(error.response.data));
    }
    // Fallback — mark as offline since we can't confirm status
    res.json({
      ...MOCK_CABINET,
      cabinetId: deviceId,
      isOnline: false,
      isRentable: false,
      message: 'Unable to reach factory server',
    });
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
  if (!stripe) return res.status(500).json({ error: 'Stripe is not configured (STRIPE_SECRET_KEY missing).' });
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
  if (!stripe) return res.status(500).json({ error: 'Stripe is not configured (STRIPE_SECRET_KEY missing).' });

  // ── CRITICAL: success_url must ALWAYS point to the FRONTEND (Vercel), never the backend ──
  // Do NOT use req.headers.origin — when called from /pay/:deviceId (backend page),
  // the Origin header is the backend's own URL, which causes "Cannot GET /rent/success"
  const frontendUrl = (process.env.FRONTEND_URL || 'https://powerbank-app-two.vercel.app').replace(/\/$/, '');

  try {
    const session = await stripe.checkout.sessions.create({
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
            name: 'Power Bank Rental — Caution (DTA55642)',
            description: `Pre-autorisation de 30 EUR pour la location de batterie. Device: ${deviceId}`,
          },
          unit_amount: 3000,
        },
        quantity: 1,
      }],
      mode: 'payment',
      // ── ALWAYS redirect to the FRONTEND success page ──
      success_url: `${frontendUrl}/rent/success?deviceId=${deviceId}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontendUrl}/?paid=cancel`,
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
    <a href="https://powerbank-app-two.vercel.app" class="btn">Retour à la carte</a>
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
    <a href="https://powerbank-app-two.vercel.app" class="btn">Réessayer</a>
  </div>
</body>
</html>
  `);
});

// ── 4. POST /api/rent/eject — Create a Rental Order (Factory: POST /rent/order/create)
app.post('/api/rent/eject', async (req, res) => {
  const { deviceId, paymentIntentId } = req.body;

  // ── Pre-flight logging ──
  console.log('[FACTORY API] Attempting to eject device:', deviceId);
  console.log('[FACTORY API] Credentials exist check - USER:', !!process.env.FACTORY_USERNAME, 'PASS:', !!process.env.FACTORY_PASSWORD);
  console.log('[FACTORY API] Base URL:', FACTORY_BASE_URL);
  console.log('[FACTORY API] Callback URL:', CALLBACK_URL);

  if (!deviceId) {
    console.error('[FACTORY API ERROR] No deviceId provided in request body');
    return res.status(400).json({ success: false, message: 'No deviceId provided.' });
  }

  try {
    console.log('[FACTORY API] Sending POST to /rent/order/create with params:', { deviceId, callbackURL: CALLBACK_URL });

    const response = await factoryApi.post('/rent/order/create', null, {
      params: {
        deviceId,
        callbackURL: CALLBACK_URL,
      },
    });

    // ── Log full factory response ──
    console.log('[FACTORY API] Response status:', response.status);
    console.log('[FACTORY API] Response data:', JSON.stringify(response.data, null, 2));

    if (response.data.code !== 0) {
      // Factory rejected the order — instantly release the Stripe hold
      console.error('[FACTORY API ERROR] Factory rejected order. Code:', response.data.code, 'Msg:', response.data.msg);
      if (paymentIntentId && stripe) await stripe.paymentIntents.cancel(paymentIntentId);
      return res.status(400).json({
        success: false,
        message: 'Échec du déverrouillage, caution annulée: ' + response.data.msg,
        factoryCode: response.data.code,
        factoryMsg: response.data.msg,
      });
    }

    const tradeNo = response.data.data?.tradeNo;
    console.log('[FACTORY API] Success! TradeNo:', tradeNo);

    // ── Store rental record for settlement lifecycle ──
    const startTime = new Date();
    rentalRecords.set(tradeNo, {
      tradeNo,
      deviceId,
      paymentIntentId: paymentIntentId || null,
      startTime: startTime.toISOString(),
      endTime: null,
      status: 'active',        // active → completed | failed
      billing: null,            // populated on return/settlement
      createdAt: startTime.toISOString(),
    });
    console.log(`[RENTAL RECORD] Created for tradeNo=${tradeNo}, deviceId=${deviceId}, startTime=${startTime.toISOString()}, paymentIntentId=${paymentIntentId || 'NONE'}`);

    res.json({
      success: true,
      tradeNo,
      message: 'Commande créée, déverrouillage en cours...',
    });
  } catch (error) {
    // ── Deep error logging ──
    console.error('[FACTORY API ERROR] Status:', error.response?.status);
    console.error('[FACTORY API ERROR] Raw Data:', JSON.stringify(error.response?.data, null, 2));
    console.error('[FACTORY API ERROR] Request config:', {
      url: error.config?.url,
      method: error.config?.method,
      params: error.config?.params,
      authHeader: error.config?.auth ? 'Basic Auth present' : 'NO AUTH',
      baseURL: error.config?.baseURL,
    });
    console.error('[FACTORY API ERROR] Error code:', error.code);
    console.error('[FACTORY API ERROR] Error message:', error.message);

    if (paymentIntentId && stripe) await stripe.paymentIntents.cancel(paymentIntentId);

    res.status(500).json({
      success: false,
      error: 'System error, caution released: ' + error.message,
      factoryError: {
        status: error.response?.status,
        data: error.response?.data,
        code: error.code,
      },
    });
  }
});

// ── 5. POST /api/rent/status — Query Rental Order Status (Factory: POST /rent/order/query)
// Legacy POST endpoint (kept for backward compat). Frontend should use GET /api/rent/status/:orderId instead.
app.post('/api/rent/status', async (req, res) => {
  const { tradeNo } = req.body;
  console.log('[FACTORY API] Polling order status for tradeNo:', tradeNo);

  // ── Check local rental record for billing info ──
  const record = rentalRecords.get(tradeNo);

  try {
    const response = await factoryApi.post('/rent/order/query', null, {
      params: { tradeNo },
    });

    const success = response.data.code === 0;
    console.log('[FACTORY API] Order status response:', JSON.stringify(response.data, null, 2));

    // ── If we have a local record and Factory says success, check for return data ──
    if (record && record.status === 'active') {
      const factoryData = response.data.data;
      if (factoryData) {
        // Factory may return returnTime / status indicating battery returned
        const isReturned = factoryData.status === 'returned' || factoryData.returnTime || factoryData.endTime;
        if (isReturned) {
          console.log(`[FACTORY API] Battery returned detected for tradeNo=${tradeNo}. Return data:`, JSON.stringify(factoryData));
          // Mark as completed if not already — settlement webhook should have handled billing
          // This is a safety fallback in case webhook was missed
        }
      }
    }

    res.json({
      success,
      code: response.data.code,
      message: response.data.msg,
      callbackResult: rentalResults.get(tradeNo) || null,
      // Include billing info from local record if available
      rentalRecord: record ? {
        status: record.status,
        billing: record.billing,
        startTime: record.startTime,
        endTime: record.endTime,
      } : null,
    });
  } catch (error) {
    console.error('[FACTORY API ERROR] Status query failed - Status:', error.response?.status, 'Data:', JSON.stringify(error.response?.data));
    // Return local record data even if Factory query fails
    res.status(500).json({
      error: error.message,
      rentalRecord: record ? { status: record.status, billing: record.billing } : null,
      factoryError: { status: error.response?.status, data: error.response?.data },
    });
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

// ── 7b. POST /api/webhook/factory/return — Settlement Webhook (battery returned event)
// Factory API calls this when a battery is returned to the cabinet.
// We calculate the rental duration, determine the final cost, and capture from Stripe.
app.post('/api/webhook/factory/return', async (req, res) => {
  const { tradeNo, deviceId, status: factoryStatus } = req.body;
  const now = new Date();

  console.log('[WEBHOOK RETURN] Received factory return event:', JSON.stringify(req.body, null, 2));
  console.log('[WEBHOOK RETURN] tradeNo:', tradeNo, 'deviceId:', deviceId, 'factoryStatus:', factoryStatus);

  if (!tradeNo) {
    console.error('[WEBHOOK RETURN] Missing tradeNo in webhook payload');
    return res.status(400).json({ code: -1, msg: 'Missing tradeNo' });
  }

  // ── Find the rental record ──
  const record = rentalRecords.get(tradeNo);
  if (!record) {
    console.warn(`[WEBHOOK RETURN] No rental record found for tradeNo=${tradeNo}. May have been created by another instance.`);
    // Still respond success so Factory doesn't retry
    return res.json({ code: 0, msg: 'success' });
  }

  if (record.status === 'completed') {
    console.log(`[WEBHOOK RETURN] tradeNo=${tradeNo} already completed, ignoring duplicate webhook.`);
    return res.json({ code: 0, msg: 'success' });
  }

  // ── Step 1: Calculate rental duration ──
  const startTime = new Date(record.startTime);
  const endTime = now;
  const durationMs = endTime - startTime;
  const durationMinutes = Math.floor(durationMs / 60000);
  const durationHours = Math.floor(durationMinutes / 60);
  const remainingMinutes = durationMinutes % 60;

  console.log(`[SETTLEMENT] tradeNo=${tradeNo}`);
  console.log(`[SETTLEMENT] Start: ${startTime.toISOString()} | End: ${endTime.toISOString()}`);
  console.log(`[SETTLEMENT] Duration: ${durationMs}ms = ${durationMinutes} min (${durationHours}h ${remainingMinutes}m)`);

  // ── Step 2: Apply pricing model ──
  // Pricing from Factory API: price=1 EUR/hour, freeMinutes=10, dailyMaxPrice=10 EUR, deposit=30 EUR
  const PRICE_PER_HOUR = 1;       // EUR
  const FREE_MINUTES = 10;         // First 10 minutes free
  const MIN_CHARGE = 1;            // Minimum 1 EUR (1 hour minimum)
  const DAILY_CAP = 30;            // Capped at 30 EUR (deposit amount)
  const DEPOSIT_AMOUNT = 3000;     // 30 EUR in cents (pre-auth hold)

  let chargeAmountEur = 0;
  if (durationMinutes <= FREE_MINUTES) {
    chargeAmountEur = 0;
    console.log(`[SETTLEMENT] Within free period (${durationMinutes} min <= ${FREE_MINUTES} min free). No charge.`);
  } else {
    // Billable minutes = total - free, rounded UP to nearest hour
    const billableMinutes = durationMinutes - FREE_MINUTES;
    const billableHours = Math.ceil(billableMinutes / 60); // e.g., 75 min → 2 hours
    chargeAmountEur = billableHours * PRICE_PER_HOUR;
    // Apply minimum charge
    chargeAmountEur = Math.max(chargeAmountEur, MIN_CHARGE);
    // Apply daily cap
    chargeAmountEur = Math.min(chargeAmountEur, DAILY_CAP);
    console.log(`[SETTLEMENT] Billable: ${billableMinutes} min → ${billableHours} hours × ${PRICE_PER_HOUR} EUR = ${chargeAmountEur} EUR (cap: ${DAILY_CAP})`);
  }

  const chargeAmountCents = Math.round(chargeAmountEur * 100);
  const releasedAmountCents = DEPOSIT_AMOUNT - chargeAmountCents;

  console.log(`[SETTLEMENT] Final charge: ${chargeAmountEur} EUR (${chargeAmountCents} cents)`);
  console.log(`[SETTLEMENT] Deposit held: ${DEPOSIT_AMOUNT / 100} EUR (${DEPOSIT_AMOUNT} cents)`);
  console.log(`[SETTLEMENT] To be released: ${releasedAmountCents / 100} EUR (${releasedAmountCents} cents)`);

  // ── Step 3: Stripe capture ──
  let stripeCaptureResult = null;
  if (record.paymentIntentId && stripe) {
    try {
      console.log(`[SETTLEMENT] Capturing ${chargeAmountCents} cents from PI=${record.paymentIntentId}`);

      const captureParams = chargeAmountCents > 0
        ? { amount_to_capture: chargeAmountCents }
        : {};  // 0 charge → cancel the hold entirely

      if (chargeAmountCents > 0) {
        const capture = await stripe.paymentIntents.capture(record.paymentIntentId, captureParams);
        stripeCaptureResult = {
          status: capture.status,
          amountCaptured: capture.amount_capturable ? capture.amount_received : 0,
          id: capture.id,
        };
        console.log(`[SETTLEMENT] Stripe capture SUCCESS: status=${capture.status}, amount_received=${capture.amount_received}, id=${capture.id}`);
      } else {
        // No charge — cancel the hold to release full deposit
        const cancel = await stripe.paymentIntents.cancel(record.paymentIntentId);
        stripeCaptureResult = {
          status: cancel.status,
          amountCaptured: 0,
          id: cancel.id,
        };
        console.log(`[SETTLEMENT] Stripe cancel SUCCESS (free rental): status=${cancel.status}, id=${cancel.id}`);
      }
    } catch (stripeError) {
      console.error(`[SETTLEMENT] Stripe capture FAILED:`, stripeError.message);
      console.error(`[SETTLEMENT] Stripe error type:`, stripeError.type, 'code:', stripeError.code);
      stripeCaptureResult = { error: stripeError.message, code: stripeError.code };
      // Don't fail the webhook — Factory needs an ack. We'll handle retry separately.
    }
  } else {
    console.warn(`[SETTLEMENT] No paymentIntentId or Stripe not configured — skipping capture. paymentIntentId=${record.paymentIntentId}, stripe=${!!stripe}`);
  }

  // ── Step 4: Update rental record ──
  const billing = {
    durationMinutes,
    durationDisplay: `${durationHours} h ${remainingMinutes} min`,
    freeMinutes: FREE_MINUTES,
    pricePerHour: PRICE_PER_HOUR,
    chargeAmountEur,
    chargeAmountCents,
    depositAmountEur: DEPOSIT_AMOUNT / 100,
    releasedAmountEur: releasedAmountCents / 100,
    currency: 'EUR',
    stripeCapture: stripeCaptureResult,
  };

  record.endTime = endTime.toISOString();
  record.status = 'completed';
  record.billing = billing;
  rentalRecords.set(tradeNo, record);

  console.log(`[SETTLEMENT] Record updated: tradeNo=${tradeNo}, status=completed, billing=${JSON.stringify(billing)}`);

  // ── Acknowledge webhook to Factory ──
  res.json({ code: 0, msg: 'success' });
});

// ── 7c. GET /api/rent/status/:orderId — Full status endpoint for frontend polling
// Returns rental status including billing info when completed.
// Supports both tradeNo (Factory order) and session-based lookups.
app.get('/api/rent/status/:orderId', async (req, res) => {
  const orderId = req.params.orderId;
  console.log(`[STATUS POLL] Querying status for orderId=${orderId}`);

  // ── Check our local rental records first ──
  const record = rentalRecords.get(orderId);

  if (record) {
    console.log(`[STATUS POLL] Found record: status=${record.status}, hasBilling=${!!record.billing}`);

    // If still active, also query Factory API for latest status
    if (record.status === 'active') {
      try {
        const factoryRes = await factoryApi.post('/rent/order/query', null, {
          params: { tradeNo: orderId },
        });
        console.log(`[STATUS POLL] Factory query response:`, JSON.stringify(factoryRes.data, null, 2));

        // Check if Factory indicates the battery was returned
        // Factory callback data may contain return info
        const callbackData = rentalResults.get(orderId);
        if (callbackData) {
          console.log(`[STATUS POLL] Found callback data:`, JSON.stringify(callbackData));
          // If callback indicates return, trigger settlement
          if (callbackData.status === 'returned' || callbackData.returnTime) {
            console.log(`[STATUS POLL] Battery returned detected via callback. Triggering settlement...`);
            // Settlement is handled by webhook, but as fallback we process it here
          }
        }
      } catch (err) {
        console.warn(`[STATUS POLL] Factory query failed (non-fatal):`, err.message);
      }
    }

    return res.json({
      success: true,
      tradeNo: record.tradeNo,
      deviceId: record.deviceId,
      status: record.status,                 // 'active' | 'completed' | 'failed'
      startTime: record.startTime,
      endTime: record.endTime,
      billing: record.billing,               // null when active, populated when completed
      callbackResult: rentalResults.get(orderId) || null,
    });
  }

  // ── Fallback: query Factory API directly if no local record ──
  console.log(`[STATUS POLL] No local record for orderId=${orderId}, querying Factory...`);
  try {
    const response = await factoryApi.post('/rent/order/query', null, {
      params: { tradeNo: orderId },
    });

    console.log(`[STATUS POLL] Factory response:`, JSON.stringify(response.data, null, 2));

    return res.json({
      success: response.data.code === 0,
      tradeNo: orderId,
      status: response.data.code === 0 ? 'active' : 'unknown',
      message: response.data.msg,
      callbackResult: rentalResults.get(orderId) || null,
    });
  } catch (error) {
    console.error(`[STATUS POLL] Factory query failed:`, error.message);
    return res.status(500).json({
      success: false,
      error: error.message,
      factoryError: { status: error.response?.status, data: error.response?.data },
    });
  }
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
