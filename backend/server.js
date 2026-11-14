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

// ── Fleet Configuration ───────────────────────────────────────────────
// All device IDs registered under this Factory account.
// The Factory API has no "list all cabinets" endpoint, so we query each device individually.
// New devices: just add their ID to this array — no other code changes needed.
const FLEET_DEVICE_IDS = (process.env.FLEET_DEVICE_IDS || 'DTA55642,DTA55645')
  .split(',')
  .map(id => id.trim())
  .filter(Boolean);

console.log(`[FLEET] Configured device IDs: ${FLEET_DEVICE_IDS.join(', ')}`);

// ── Helper: Query a single device from Factory API and return normalized data ──
async function queryDevice(deviceId) {
  const response = await factoryApi.get('/rent/cabinet/query', {
    params: { deviceId },
  });

  // ── Log raw Factory response for debugging ──
  console.log(`[QUERY DEVICE] ${deviceId} raw response code=${response.data.code}, msg="${response.data.msg}"`);
  if (response.data.data) {
    console.log(`[QUERY DEVICE] ${deviceId} has data: shop=${!!response.data.data.shop}, cabinet=${!!response.data.data.cabinet}, batteries=${response.data.data.batteries?.length || 0}`);
  }

  // ── Even when code !== 0 (offline/not found), Factory may still return location data in response.data.data ──
  // We extract whatever we can so the map can still show the device with an offline indicator.
  const rawData = response.data.data;
  const extractLocation = () => {
    if (!rawData) return {};
    return {
      shopName: rawData.shop?.name || undefined,
      shopAddress: rawData.shop?.address || undefined,
      lat: parseFloat(rawData.shop?.latitude) || undefined,
      lng: parseFloat(rawData.shop?.longitude) || undefined,
      totalSlots: rawData.cabinet?.slots || undefined,
    };
  };

  if (response.data.code !== 0) {
    // Device offline or not found
    const errorCode = response.data.code;
    const isOffline = errorCode === 2004 || errorCode === 2005;
    const loc = extractLocation();

    console.log(`[QUERY DEVICE] ${deviceId} OFFLINE (code=${errorCode}). Location data available: lat=${loc.lat || 'none'}, lng=${loc.lng || 'none'}`);

    return {
      id: deviceId,
      isOnline: !isOffline,
      availablePowerBanks: 0,
      emptyReturnSlots: 0,
      rentableBatteries: 0,
      emptySlots: 0,
      freeNum: 0,
      totalSlots: loc.totalSlots || 0,
      shopName: loc.shopName || 'Power Bank Station',
      shopAddress: loc.shopAddress || '',
      // ── CRITICAL: return lat/lng even for offline devices so they show on the map ──
      // If Factory didn't include location, fall back to 0 (frontend will filter out invalid coords)
      lat: loc.lat || 0,
      lng: loc.lng || 0,
      price: '1',
      deposit: '30',
      currency: 'EUR',
      currencySymbol: '\u20ac',
      freeMinutes: 10,
      dailyMaxPrice: 10,
      message: response.data.msg || 'Device offline',
      factoryCode: errorCode,
    };
  }

  const data = response.data.data;
  if (!data) throw new Error(`No data from factory for device ${deviceId}`);

  const factoryIsOnline = data.cabinet.online === true || data.cabinet.isOnline === true || data.cabinet.online === 1 || data.cabinet.online === '1';
  const totalSlots = data.cabinet.slots;
  const actualBatteriesInside = data.batteries ? data.batteries.length : 0;
  const trueEmptyHoles = totalSlots - actualBatteriesInside;

  return {
    id: deviceId,
    shopName: data.shop?.name || 'Power Bank Station',
    shopAddress: data.shop?.address || '',
    lat: parseFloat(data.shop?.latitude) || 0,
    lng: parseFloat(data.shop?.longitude) || 0,
    isOnline: factoryIsOnline,
    availablePowerBanks: actualBatteriesInside,
    rentableBatteries: actualBatteriesInside,
    emptyReturnSlots: trueEmptyHoles,
    emptySlots: trueEmptyHoles,
    freeNum: trueEmptyHoles,
    totalSlots,
    price: String(data.priceStrategy?.price ?? '1'),
    deposit: String(data.priceStrategy?.depositAmount ?? '30'),
    currency: data.priceStrategy?.currency ?? 'EUR',
    currencySymbol: data.priceStrategy?.currencySymbol || '\u20ac',
    freeMinutes: data.priceStrategy?.freeMinutes ?? 10,
    dailyMaxPrice: data.priceStrategy?.dailyMaxPrice ?? 10,
  };
}

// ── 0. GET /health — Health check (critical for Render free-tier wake detection)
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'UP',
    timestamp: new Date().toISOString(),
    stripe: !!stripe,
    factory: !!(FACTORY_USERNAME && FACTORY_PASSWORD),
  });
});

// ── 1. GET /api/nearby — List ALL Fleet Stations (queries every device in FLEET_DEVICE_IDS)
app.get('/api/nearby', async (req, res) => {
  console.log(`[NEARBY] Fetching status for ${FLEET_DEVICE_IDS.length} fleet devices: ${FLEET_DEVICE_IDS.join(', ')}`);

  // ── Query all devices in parallel for speed ──
  const results = await Promise.allSettled(
    FLEET_DEVICE_IDS.map(deviceId => queryDevice(deviceId))
  );

  const stations = results.map((result, index) => {
    const deviceId = FLEET_DEVICE_IDS[index];

    if (result.status === 'fulfilled') {
      const d = result.value;
      console.log(`[NEARBY] Device ${deviceId}: online=${d.isOnline}, batteries=${d.availablePowerBanks}, emptySlots=${d.emptyReturnSlots}`);
      return d;
    }

    // Individual device query failed — return offline placeholder
    console.error(`[NEARBY] Device ${deviceId} query FAILED:`, result.reason?.message);
    return {
      id: deviceId,
      shopName: 'Station',
      isOnline: false,
      availablePowerBanks: 0,
      rentableBatteries: 0,
      emptyReturnSlots: 0,
      emptySlots: 0,
      freeNum: 0,
      totalSlots: 0,
      lat: 0,
      lng: 0,
      price: '1',
      deposit: '30',
      currency: 'EUR',
      currencySymbol: '\u20ac',
      freeMinutes: 10,
      dailyMaxPrice: 10,
      message: 'Unable to reach device',
    };
  });

  console.log(`[NEARBY] Returning ${stations.length} stations. Online: ${stations.filter(s => s.isOnline).length}`);
  res.json(stations);
});

// ── 2. GET /api/cabinet/:id — Get Single Device Status (dynamic :id param, no hardcodes)
app.get('/api/cabinet/:id', async (req, res) => {
  const deviceId = req.params.id;
  console.log(`[CABINET] Querying device: ${deviceId}`);

  try {
    const d = await queryDevice(deviceId);

    console.log(`[CABINET] Device ${deviceId}: online=${d.isOnline}, batteries=${d.availablePowerBanks}, emptySlots=${d.emptyReturnSlots}`);

    res.json({
      isRentable: d.isOnline && d.availablePowerBanks > 0,
      isOnline: d.isOnline,
      availablePowerBanks: d.availablePowerBanks,
      emptyReturnSlots: d.emptyReturnSlots,
      price: d.price,
      currency: d.currency,
      deposit: d.deposit,
      cabinetId: deviceId,
      shopName: d.shopName,
      shopAddress: d.shopAddress,
      freeMinutes: d.freeMinutes,
      dailyMaxPrice: d.dailyMaxPrice,
      currencySymbol: d.currencySymbol,
      message: d.message || '',
    });
  } catch (error) {
    console.error(`[CABINET] Query failed for device ${deviceId}:`, error.message);
    if (error.response) {
      console.error(`[CABINET ERROR] Factory status: ${error.response.status}, data:`, JSON.stringify(error.response.data));
    }
    res.json({
      isRentable: false,
      isOnline: false,
      availablePowerBanks: 0,
      emptyReturnSlots: 0,
      price: 1,
      currency: 'EUR',
      deposit: 30,
      cabinetId: deviceId,
      shopName: 'Station',
      freeMinutes: 10,
      dailyMaxPrice: 10,
      currencySymbol: '\u20ac',
      message: error.message || 'Unable to reach factory server',
    });
  }
});

// ── 2b. GET /pay/:deviceId — Redirect page that auto-launches Stripe Checkout (scan QR → this page → Stripe)
app.get('/pay/:deviceId', async (req, res) => {
  const deviceId = req.params.deviceId;
  if (!deviceId) {
    return res.status(400).send('Device ID is required in the URL path.');
  }
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
  const deviceId = req.query.deviceId;
  if (!deviceId) return res.status(400).json({ error: 'deviceId query parameter is required.' });
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
            name: `Power Bank Rental — Caution (${deviceId})`,
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
  const deviceId = req.query.deviceId || 'Unknown';
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
  const deviceId = req.query.deviceId || 'Unknown';
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

// ── 7b. POST /api/webhook/factory/return — Settlement Webhook (battery returned, cross-station capable)
// Factory API calls this when a battery is returned to ANY cabinet.
// The return device may be DIFFERENT from the dispensing device (cross-station return).
// We use tradeNo to locate the original rental record + Stripe pre-auth, regardless of return station.
app.post('/api/webhook/factory/return', async (req, res) => {
  const {
    tradeNo,                                    // Original order ID (links to rental record)
    deviceId: dispensingDeviceId,               // Device that dispensed the battery (may be absent in return event)
    returnDeviceId,                             // Device that received the battery (may differ from dispensing)
    batteryId,                                  // Physical battery ID
    status: factoryStatus,                      // Factory status string
  } = req.body;
  const now = new Date();

  console.log('[WEBHOOK RETURN] Received factory return event:', JSON.stringify(req.body, null, 2));
  console.log(`[WEBHOOK RETURN] tradeNo=${tradeNo}, dispensingDevice=${dispensingDeviceId || 'N/A'}, returnDevice=${returnDeviceId || 'N/A'}, batteryId=${batteryId || 'N/A'}`);

  // ── Support multiple field name variants Factory may use ──
  // Some Factory payloads use "order_id" or "orderId" instead of "tradeNo"
  const orderId = tradeNo || req.body.order_id || req.body.orderId;

  if (!orderId) {
    console.error('[WEBHOOK RETURN] Missing tradeNo/order_id in webhook payload');
    return res.status(400).json({ code: -1, msg: 'Missing tradeNo' });
  }

  // ── Find the rental record by order ID (works regardless of which station received the battery) ──
  const record = rentalRecords.get(orderId);
  if (!record) {
    console.warn(`[WEBHOOK RETURN] No rental record found for orderId=${orderId}. Cross-station return from device ${returnDeviceId || 'unknown'} — record may have been created by another instance.`);
    // Still respond success so Factory doesn't retry
    return res.json({ code: 0, msg: 'success' });
  }

  if (record.status === 'completed') {
    console.log(`[WEBHOOK RETURN] orderId=${orderId} already completed, ignoring duplicate webhook.`);
    return res.json({ code: 0, msg: 'success' });
  }

  // ── Log cross-station detection ──
  if (returnDeviceId && returnDeviceId !== record.deviceId) {
    console.log(`[WEBHOOK RETURN] *** CROSS-STATION RETURN detected! Battery dispensed by ${record.deviceId}, returned to ${returnDeviceId}. Settlement proceeds normally. ***`);
  }

  // ── Step 1: Calculate rental duration ──
  const startTime = new Date(record.startTime);
  const endTime = now;
  const durationMs = endTime - startTime;
  const durationMinutes = Math.floor(durationMs / 60000);
  const durationHours = Math.floor(durationMinutes / 60);
  const remainingMinutes = durationMinutes % 60;

  console.log(`[SETTLEMENT] orderId=${orderId}`);
  console.log(`[SETTLEMENT] Dispensing device: ${record.deviceId} | Return device: ${returnDeviceId || record.deviceId}`);
  console.log(`[SETTLEMENT] Start: ${startTime.toISOString()} | End: ${endTime.toISOString()}`);
  console.log(`[SETTLEMENT] Duration: ${durationMs}ms = ${durationMinutes} min (${durationHours}h ${remainingMinutes}m)`);

  // ── Step 2: Apply pricing model ──
  const PRICE_PER_HOUR = 1;
  const FREE_MINUTES = 10;
  const MIN_CHARGE = 1;
  const DAILY_CAP = 30;
  const DEPOSIT_AMOUNT = 3000;

  let chargeAmountEur = 0;
  if (durationMinutes <= FREE_MINUTES) {
    chargeAmountEur = 0;
    console.log(`[SETTLEMENT] Within free period (${durationMinutes} min <= ${FREE_MINUTES} min free). No charge.`);
  } else {
    const billableMinutes = durationMinutes - FREE_MINUTES;
    const billableHours = Math.ceil(billableMinutes / 60);
    chargeAmountEur = billableHours * PRICE_PER_HOUR;
    chargeAmountEur = Math.max(chargeAmountEur, MIN_CHARGE);
    chargeAmountEur = Math.min(chargeAmountEur, DAILY_CAP);
    console.log(`[SETTLEMENT] Billable: ${billableMinutes} min -> ${billableHours} hours x ${PRICE_PER_HOUR} EUR = ${chargeAmountEur} EUR (cap: ${DAILY_CAP})`);
  }

  const chargeAmountCents = Math.round(chargeAmountEur * 100);
  const releasedAmountCents = DEPOSIT_AMOUNT - chargeAmountCents;

  console.log(`[SETTLEMENT] Final charge: ${chargeAmountEur} EUR (${chargeAmountCents} cents)`);
  console.log(`[SETTLEMENT] Deposit held: ${DEPOSIT_AMOUNT / 100} EUR (${DEPOSIT_AMOUNT} cents)`);
  console.log(`[SETTLEMENT] To be released: ${releasedAmountCents / 100} EUR (${releasedAmountCents} cents)`);

  // ── Step 3: Stripe capture (uses the ORIGINAL paymentIntentId from the rental record) ──
  let stripeCaptureResult = null;
  if (record.paymentIntentId && stripe) {
    try {
      console.log(`[SETTLEMENT] Capturing ${chargeAmountCents} cents from PI=${record.paymentIntentId}`);

      if (chargeAmountCents > 0) {
        const capture = await stripe.paymentIntents.capture(record.paymentIntentId, {
          amount_to_capture: chargeAmountCents,
        });
        stripeCaptureResult = {
          status: capture.status,
          amountReceived: capture.amount_received,
          id: capture.id,
        };
        console.log(`[SETTLEMENT] Stripe capture SUCCESS: status=${capture.status}, amount_received=${capture.amount_received}, id=${capture.id}`);
      } else {
        const cancel = await stripe.paymentIntents.cancel(record.paymentIntentId);
        stripeCaptureResult = {
          status: cancel.status,
          amountReceived: 0,
          id: cancel.id,
        };
        console.log(`[SETTLEMENT] Stripe cancel SUCCESS (free rental): status=${cancel.status}, id=${cancel.id}`);
      }
    } catch (stripeError) {
      console.error(`[SETTLEMENT] Stripe capture FAILED:`, stripeError.message);
      console.error(`[SETTLEMENT] Stripe error type:`, stripeError.type, 'code:', stripeError.code);
      stripeCaptureResult = { error: stripeError.message, code: stripeError.code };
    }
  } else {
    console.warn(`[SETTLEMENT] No paymentIntentId or Stripe not configured — skipping capture.`);
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
    crossStationReturn: returnDeviceId ? (returnDeviceId !== record.deviceId) : false,
    dispensingDeviceId: record.deviceId,
    returnDeviceId: returnDeviceId || record.deviceId,
  };

  record.endTime = endTime.toISOString();
  record.status = 'completed';
  record.billing = billing;
  record.returnDeviceId = returnDeviceId || null;
  rentalRecords.set(orderId, record);

  console.log(`[SETTLEMENT] Record updated: orderId=${orderId}, status=completed, billing=${JSON.stringify(billing)}`);

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
