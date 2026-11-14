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

// ── Body parsing: support BOTH JSON and x-www-form-urlencoded ──
// IoT factories (ChargeNow/Bajie) often send form-urlencoded payloads, NOT JSON.
// Without urlencoded middleware, req.body is undefined for form-encoded webhooks.
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
// ── Factory API callback URL ──
// This is passed to Factory's /rent/order/create as the callbackURL.
// The Factory sends async rental results (including return events) to this URL.
// CRITICAL: Must point to the settlement webhook, not just the callback receiver.
const CALLBACK_URL = process.env.CALLBACK_URL || 'https://powerbank-app-im73.onrender.com/api/webhook/factory/return';

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
    console.log('[FACTORY API] response.data.data (full):', JSON.stringify(response.data.data, null, 2));
    console.log('[FACTORY API] response.data.data keys:', response.data.data ? Object.keys(response.data.data) : 'NO DATA');

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
    // ── Extract batteryId from Factory response if available ──
    // Factory's /rent/order/create may return batteryId/batterySn in response.data.data
    // This is CRITICAL for reverse lookup in the webhook when Factory doesn't send our tradeNo.
    // We check ALL possible field names the Factory might use.
    const factoryDataObj = response.data.data || {};
    const batteryId = factoryDataObj.batteryId
      || factoryDataObj.battery_id
      || factoryDataObj.batterySn
      || factoryDataObj.battery_sn
      || factoryDataObj.powerBankId
      || factoryDataObj.power_bank_id
      || factoryDataObj.bid
      || null;

    // ── Also extract any additional identifiers Factory may provide ──
    const factoryOrderId = factoryDataObj.orderId || factoryDataObj.order_id || factoryDataObj.sn || null;
    const factoryDeviceId = factoryDataObj.deviceId || factoryDataObj.device_id || factoryDataObj.cabinetId || factoryDataObj.cabinet_id || deviceId;

    console.log('[FACTORY API] Success! TradeNo:', tradeNo);
    console.log('[FACTORY API] Extracted batteryId:', batteryId || 'NOT PROVIDED BY FACTORY');
    console.log('[FACTORY API] Extracted factoryOrderId:', factoryOrderId || 'N/A');
    console.log('[FACTORY API] Extracted factoryDeviceId:', factoryDeviceId || 'N/A');

    if (!batteryId) {
      console.warn('[FACTORY API] ⚠️ No batteryId in Factory response! Webhook reverse lookup by batteryId will NOT work for this order.');
      console.warn('[FACTORY API] Full response.data.data for debugging:', JSON.stringify(factoryDataObj, null, 2));
    }

    // ── Store rental record for settlement lifecycle ──
    const startTime = new Date();
    rentalRecords.set(tradeNo, {
      tradeNo,
      orderId: tradeNo,                   // alias for debugging clarity
      deviceId,                            // dispensing station
      batteryId,                           // ← CRITICAL for webhook reverse lookup
      factoryOrderId,                     // Factory's own order ID (if different from tradeNo)
      paymentIntentId: paymentIntentId || null,
      startTime: startTime.toISOString(),
      endTime: null,
      status: 'active',        // active → completed | failed
      billing: null,            // populated on return/settlement
      createdAt: startTime.toISOString(),
    });
    console.log(`[RENTAL RECORD] Created: tradeNo=${tradeNo}, deviceId=${deviceId}, batteryId=${batteryId || 'N/A'}, paymentIntentId=${paymentIntentId || 'NONE'}`);
    console.log(`[RENTAL RECORD] Full record:`, JSON.stringify(rentalRecords.get(tradeNo), null, 2));

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
// Factory API sends async events here (rental created, battery ejected, battery returned, etc.)
// This endpoint stores the callback data AND checks if the battery was returned.
// If a return is detected, it triggers settlement inline (since CALLBACK_URL may point here).
app.post('/api/rent/callback', async (req, res) => {
  // ── Deep logging: catch everything the Factory sends ──
  console.log('[FACTORY CALLBACK] Headers:', JSON.stringify(req.headers, null, 2));
  console.log('[FACTORY CALLBACK] Body (raw):', JSON.stringify(req.body, null, 2));
  console.log('[FACTORY CALLBACK] Content-Type:', req.headers['content-type']);

  // ── Store callback data for debugging/polling ──
  const body = req.body || {};
  // Try every possible field name for the order identifier
  const tradeNo = body.tradeNo || body.order_id || body.orderId || body.orderId || body.sn || body.orderNo;
  const batteryId = body.batteryId || body.battery_id || body.batterySn || body.battery_sn;
  const deviceId = body.deviceId || body.device_id || body.cabinetId || body.cabinet_id;
  const factoryStatus = body.status || body.type || body.event || body.action;

  if (tradeNo) {
    rentalResults.set(tradeNo, { ...body, timestamp: Date.now() });
    console.log(`[FACTORY CALLBACK] Stored callback for tradeNo=${tradeNo}, status=${factoryStatus}, batteryId=${batteryId || 'N/A'}, deviceId=${deviceId || 'N/A'}`);
  } else {
    console.warn('[FACTORY CALLBACK] No tradeNo/order_id found in callback. Available fields:', Object.keys(body));
  }

  // ── Check if this callback indicates a battery return ──
  // Factory may send status='returned', type='return', event='battery_return', etc.
  const returnKeywords = ['return', 'returned', 'end', 'ended', 'finish', 'finished', 'complete', 'completed'];
  const isReturnEvent = factoryStatus && returnKeywords.some(kw =>
    String(factoryStatus).toLowerCase().includes(kw)
  );

  if (isReturnEvent) {
    console.log(`[FACTORY CALLBACK] *** RETURN EVENT detected. tradeNo=${tradeNo || 'N/A'}, batteryId=${batteryId || 'N/A'}, deviceId=${deviceId || 'N/A'}. Triggering settlement... ***`);

    // ── CROSS-STATION SAFE record lookup ──
    // 1. Try by tradeNo first
    let record = tradeNo ? rentalRecords.get(tradeNo) : null;
    let resolvedTradeNo = tradeNo;

    // 2. If no match by tradeNo, try reverse lookup by batteryId
    //    (cross-station safe: batteryId is tied to the battery, not the station)
    if (!record && batteryId) {
      console.log(`[FACTORY CALLBACK] No record by tradeNo. Trying reverse lookup by batteryId=${batteryId}...`);
      for (const [tn, rec] of rentalRecords.entries()) {
        if (rec.status === 'active' && rec.batteryId && rec.batteryId === batteryId) {
          record = rec;
          resolvedTradeNo = tn;
          console.log(`[FACTORY CALLBACK] *** MATCH by batteryId! tradeNo=${tn} ***`);
          break;
        }
      }
    }

    // CRITICAL: Do NOT match by device_id!
    // In cross-station returns, device_id is the RETURN station, not the dispensing station.

    if (record && record.status === 'active') {
      try {
        await settleRental(resolvedTradeNo, record, body.returnDeviceId || body.return_device_id || deviceId, batteryId);
        console.log(`[FACTORY CALLBACK] Settlement completed for tradeNo=${resolvedTradeNo}`);
      } catch (err) {
        console.error(`[FACTORY CALLBACK] Settlement FAILED for tradeNo=${resolvedTradeNo}:`, err.message);
      }
    } else if (record && record.status === 'completed') {
      console.log(`[FACTORY CALLBACK] tradeNo=${resolvedTradeNo} already completed, ignoring.`);
    } else {
      console.warn(`[FACTORY CALLBACK] No active rental record found. Tried tradeNo=${tradeNo}, batteryId=${batteryId}. Cannot settle.`);
    }
  }

  // Always respond success so Factory doesn't retry
  res.json({ code: 0, msg: 'success' });
});

// ── Settlement Helper: Calculate duration, update status, then capture Stripe ──
// Extracted as a standalone function so both the webhook and callback endpoint can call it.
// CRITICAL: Status is set to 'completed' BEFORE Stripe capture. Even if Stripe fails,
// the timer must stop and the user must see the receipt.
async function settleRental(orderId, record, returnDeviceId, batteryId) {
  const now = new Date();
  const startTime = new Date(record.startTime);
  const endTime = now;
  const durationMs = endTime - startTime;
  const durationMinutes = Math.floor(durationMs / 60000);
  const durationHours = Math.floor(durationMinutes / 60);
  const remainingMinutes = durationMinutes % 60;
  const durationSeconds = Math.floor(durationMs / 1000);

  console.log(`[SETTLEMENT] orderId=${orderId}`);
  console.log(`[SETTLEMENT] Dispensing device: ${record.deviceId} | Return device: ${returnDeviceId || record.deviceId}`);
  console.log(`[SETTLEMENT] Battery ID: ${batteryId || 'N/A'}`);
  console.log(`[SETTLEMENT] Start: ${startTime.toISOString()} | End: ${endTime.toISOString()}`);
  console.log(`[SETTLEMENT] Duration: ${durationMs}ms = ${durationMinutes} min (${durationHours}h ${remainingMinutes}m)`);

  // ── Step 1: Apply pricing model ──
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

  // ── Step 2: CRITICAL — Update rental record to 'completed' BEFORE Stripe capture ──
  // Even if Stripe fails, the frontend timer must stop and the user must see the receipt.
  const billing = {
    durationMinutes,
    durationSeconds,
    durationDisplay: `${durationHours} h ${remainingMinutes} min`,
    freeMinutes: FREE_MINUTES,
    pricePerHour: PRICE_PER_HOUR,
    chargeAmountEur,
    chargeAmountCents,
    depositAmountEur: DEPOSIT_AMOUNT / 100,
    releasedAmountEur: releasedAmountCents / 100,
    currency: 'EUR',
    crossStationReturn: returnDeviceId ? (returnDeviceId !== record.deviceId) : false,
    dispensingDeviceId: record.deviceId,
    returnDeviceId: returnDeviceId || record.deviceId,
    stripeCapture: null, // populated after Stripe capture below
  };

  record.endTime = endTime.toISOString();
  record.status = 'completed';
  record.billing = billing;
  record.returnDeviceId = returnDeviceId || null;
  rentalRecords.set(orderId, record);

  console.log(`[WEBHOOK SUCCESS] Order updated to completed. Final Cost: ${chargeAmountEur} EUR`);
  console.log(`[SETTLEMENT] Record saved: orderId=${orderId}, status=completed`);

  // ── Step 3: Stripe capture (AFTER status is saved) ──
  // If this fails, the order is still marked completed — timer stops, user sees receipt.
  // The Stripe hold remains and must be manually captured or released.
  if (record.paymentIntentId && stripe) {
    try {
      console.log(`[SETTLEMENT] Capturing ${chargeAmountCents} cents from PI=${record.paymentIntentId}`);

      if (chargeAmountCents > 0) {
        const capture = await stripe.paymentIntents.capture(record.paymentIntentId, {
          amount_to_capture: chargeAmountCents,
        });
        billing.stripeCapture = {
          status: capture.status,
          amountReceived: capture.amount_received,
          id: capture.id,
        };
        console.log(`[SETTLEMENT] Stripe capture SUCCESS: status=${capture.status}, amount_received=${capture.amount_received}, id=${capture.id}`);
      } else {
        const cancel = await stripe.paymentIntents.cancel(record.paymentIntentId);
        billing.stripeCapture = {
          status: cancel.status,
          amountReceived: 0,
          id: cancel.id,
        };
        console.log(`[SETTLEMENT] Stripe cancel SUCCESS (free rental): status=${cancel.status}, id=${cancel.id}`);
      }

      // Update the record with Stripe capture result
      record.billing = billing;
      rentalRecords.set(orderId, record);
    } catch (stripeError) {
      console.error(`[SETTLEMENT] Stripe capture FAILED:`, stripeError.message);
      console.error(`[SETTLEMENT] Stripe error type:`, stripeError.type, 'code:', stripeError.code);
      billing.stripeCapture = { error: stripeError.message, code: stripeError.code };
      record.billing = billing;
      rentalRecords.set(orderId, record);
      // DO NOT throw — the order is already marked completed. Timer stops, user sees receipt.
    }
  } else {
    console.warn(`[SETTLEMENT] No paymentIntentId or Stripe not configured — skipping capture. Order is still marked completed.`);
  }

  console.log(`[SETTLEMENT] COMPLETE for orderId=${orderId}, charge=${chargeAmountEur} EUR`);
  return billing;
}

// ── 7b. POST /api/webhook/factory/return — Settlement Webhook (battery returned, cross-station capable)
// Factory API calls this when a battery is returned to ANY cabinet.
// This endpoint handles ALL possible Factory payload formats (JSON, form-urlencoded, etc.)
// and ALL possible field names (tradeNo, order_id, battery_id, device_id, sn, etc.)
app.post('/api/webhook/factory/return', async (req, res) => {
  // ── BULLETPROOF LOGGING: Log EVERYTHING at the very first line ──
  // This must execute before ANY other logic so we never lose webhook data
  // even if the handler crashes downstream.
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('[WEBHOOK RECEIVED] Timestamp:', new Date().toISOString());
  console.log('[WEBHOOK RECEIVED] Method:', req.method, 'URL:', req.originalUrl);
  console.log('[WEBHOOK PAYLOAD]:', JSON.stringify(req.body, null, 2));
  console.log('[WEBHOOK QUERY]:', JSON.stringify(req.query, null, 2));
  console.log('[WEBHOOK RECEIVED] Headers:', JSON.stringify(req.headers, null, 2));
  console.log('[WEBHOOK RECEIVED] Content-Type:', req.headers['content-type']);
  console.log('[WEBHOOK RECEIVED] Body type:', typeof req.body);
  console.log('[WEBHOOK RECEIVED] Body keys:', req.body ? Object.keys(req.body) : 'NO BODY');
  // If body is a string or empty, log it as-is for debugging form-urlencoded issues
  if (typeof req.body === 'string') {
    console.log('[WEBHOOK RECEIVED] Body is STRING (not parsed):', req.body);
  }
  if (!req.body || (typeof req.body === 'object' && Object.keys(req.body).length === 0)) {
    console.warn('[WEBHOOK RECEIVED] ⚠️ Body is EMPTY or UNPARSED. Checking raw body and query...');
    console.log('[WEBHOOK RECEIVED] req.query (fallback):', JSON.stringify(req.query));
  }
  console.log('═══════════════════════════════════════════════════════════════');

  const body = req.body || {};
  const query = req.query || {};
  // Merge query params into body — some Factory APIs send data as query params instead of body
  const mergedData = { ...query, ...body };
  const now = new Date();

  // ── Extract ALL possible identifier fields from merged (body + query) Factory payload ──
  // Different Factory API versions and event types use different field names.
  // We also check query params since some Factory callbacks send data as URL query params.
  const tradeNo      = mergedData.tradeNo || mergedData.trade_no;
  const orderId      = tradeNo || mergedData.order_id || mergedData.orderId || mergedData.orderNo || mergedData.order_no || mergedData.sn;
  const batteryId    = mergedData.batteryId || mergedData.battery_id || mergedData.batterySn || mergedData.battery_sn || mergedData.powerBankId || mergedData.power_bank_id;
  const deviceId     = mergedData.deviceId || mergedData.device_id || mergedData.cabinetId || mergedData.cabinet_id || mergedData.machineId || mergedData.machine_id;
  const returnDeviceId = mergedData.returnDeviceId || mergedData.return_device_id || mergedData.returnCabinetId || mergedData.return_cabinet_id || deviceId;
  const factoryStatus = mergedData.status || mergedData.type || mergedData.event || mergedData.action || mergedData.eventType;

  console.log(`[WEBHOOK RETURN] Parsed identifiers:`);
  console.log(`  orderId/tradeNo:  ${orderId || 'NOT FOUND'}`);
  console.log(`  batteryId:        ${batteryId || 'NOT FOUND'}`);
  console.log(`  deviceId:         ${deviceId || 'NOT FOUND'}`);
  console.log(`  returnDeviceId:   ${returnDeviceId || 'NOT FOUND'}`);
  console.log(`  factoryStatus:    ${factoryStatus || 'NOT FOUND'}`);

  // ── Step 1: Find the rental record ──
  // CROSS-STATION SAFE MATCHING STRATEGY (in priority order):
  //
  // 1. Direct match by orderId/tradeNo (best case — Factory sends our tradeNo)
  // 2. Reverse lookup by batteryId (Factory sends battery_id without our tradeNo)
  // 3. Factory API /rent/order/query fallback (Factory sends its own order_id/sn)
  //
  // CRITICAL: We do NOT match by device_id!
  // In a cross-station return (rented at Station A, returned at Station B),
  // the webhook's device_id is Station B — the RETURN station, not the dispensing station.
  // Matching by device_id would find the wrong order (or no order).
  let record = null;
  let resolvedOrderId = null;
  let matchStrategy = 'NONE';

  // ── Strategy 1: Direct match by orderId / tradeNo ──
  if (orderId) {
    record = rentalRecords.get(orderId);
    if (record) {
      resolvedOrderId = orderId;
      matchStrategy = 'TRADE_NO_DIRECT';
      console.log(`[WEBHOOK RETURN] *** MATCH by tradeNo=${orderId} ***`);
    }
  }

  // ── Strategy 2: Reverse lookup by batteryId ──
  // The Factory may send only a battery_id without our tradeNo.
  // We search all ACTIVE rental records for one with a matching batteryId.
  // This is cross-station safe: batteryId is tied to the battery, not the station.
  if (!record && batteryId) {
    console.log(`[WEBHOOK RETURN] Strategy 2: Reverse lookup by batteryId=${batteryId}...`);
    for (const [tn, rec] of rentalRecords.entries()) {
      if (rec.status === 'active') {
        console.log(`[WEBHOOK RETURN]   Checking: tradeNo=${tn}, batteryId=${rec.batteryId || 'N/A'}, deviceId=${rec.deviceId}`);
        if (rec.batteryId && rec.batteryId === batteryId) {
          record = rec;
          resolvedOrderId = tn;
          matchStrategy = 'BATTERY_ID_REVERSE';
          console.log(`[WEBHOOK RETURN] *** MATCH by batteryId! tradeNo=${tn} ***`);
          break;
        }
      }
    }
    if (!record) {
      console.warn(`[WEBHOOK RETURN] batteryId=${batteryId} did not match any active rental.`);
    }
  }

  // ── Strategy 3: Factory API /rent/order/query fallback ──
  // If the Factory sent its own order_id or sn (not our tradeNo), we can query
  // the Factory API to get the full order details, which should include our tradeNo
  // or the batteryId we need.
  if (!record && orderId) {
    console.log(`[WEBHOOK RETURN] Strategy 3: Querying Factory API for orderId=${orderId}...`);
    try {
      const factoryQueryRes = await factoryApi.post('/rent/order/query', null, {
        params: { tradeNo: orderId },
      });
      const factoryOrderData = factoryQueryRes.data?.data;
      console.log(`[WEBHOOK RETURN] Factory order/query response:`, JSON.stringify(factoryQueryRes.data, null, 2));

      if (factoryOrderData) {
        // The Factory's order/query should return the tradeNo we originally sent
        const factoryTradeNo = factoryOrderData.tradeNo || factoryOrderData.trade_no;
        if (factoryTradeNo) {
          record = rentalRecords.get(factoryTradeNo);
          if (record) {
            resolvedOrderId = factoryTradeNo;
            matchStrategy = 'FACTORY_QUERY_TRADE_NO';
            console.log(`[WEBHOOK RETURN] *** MATCH via Factory query! tradeNo=${factoryTradeNo} ***`);
          }
        }

        // If still no match, try batteryId from Factory query response
        if (!record) {
          const factoryBatteryId = factoryOrderData.batteryId || factoryOrderData.battery_id || factoryOrderData.batterySn || factoryOrderData.battery_sn;
          if (factoryBatteryId) {
            console.log(`[WEBHOOK RETURN] Factory returned batteryId=${factoryBatteryId}. Trying reverse lookup...`);
            for (const [tn, rec] of rentalRecords.entries()) {
              if (rec.status === 'active' && rec.batteryId && rec.batteryId === factoryBatteryId) {
                record = rec;
                resolvedOrderId = tn;
                matchStrategy = 'FACTORY_QUERY_BATTERY_ID';
                console.log(`[WEBHOOK RETURN] *** MATCH via Factory query batteryId! tradeNo=${tn} ***`);
                break;
              }
            }
          }
        }

        // ── BONUS: If Factory query shows the battery is already returned,
        // and we found the record above, settlement will be triggered below.
        // If we STILL haven't found the record, log all active records for debugging. ──
      }
    } catch (factoryErr) {
      console.warn(`[WEBHOOK RETURN] Factory /rent/order/query failed:`, factoryErr.message);
    }
  }

  // ── If no record found at all, respond success (Factory won't retry) ──
  if (!record) {
    console.warn(`[WEBHOOK RETURN] ❌ NO MATCH FOUND. Tried: ${matchStrategy}. Tried orderId=${orderId}, batteryId=${batteryId}. Responding success to prevent Factory retries.`);
    console.log('[MATCHED ORDER]: Not Found');
    // Log all active rental records for debugging
    const activeRecords = [];
    for (const [tn, rec] of rentalRecords.entries()) {
      if (rec.status === 'active') activeRecords.push({ tradeNo: tn, orderId: rec.orderId, deviceId: rec.deviceId, batteryId: rec.batteryId || 'N/A', factoryOrderId: rec.factoryOrderId || 'N/A' });
    }
    console.log(`[WEBHOOK RETURN] Active rental records in memory (${activeRecords.length}):`, JSON.stringify(activeRecords, null, 2));
    return res.json({ code: 0, msg: 'success' });
  }

  console.log(`[MATCHED ORDER]: Found (strategy: ${matchStrategy}, orderId: ${resolvedOrderId})`);
  console.log(`[WEBHOOK RETURN] Match strategy: ${matchStrategy}. Resolved orderId: ${resolvedOrderId}`);

  // ── If already completed, ignore duplicate ──
  if (record.status === 'completed') {
    console.log(`[WEBHOOK RETURN] orderId=${resolvedOrderId} already completed, ignoring duplicate webhook.`);
    return res.json({ code: 0, msg: 'success' });
  }

  // ── Log cross-station detection ──
  if (returnDeviceId && returnDeviceId !== record.deviceId) {
    console.log(`[WEBHOOK RETURN] *** CROSS-STATION RETURN detected! Battery dispensed by ${record.deviceId}, returned to ${returnDeviceId}. Settlement proceeds normally. ***`);
  }

  // ── Step 2: Run settlement (status='completed' is set BEFORE Stripe capture) ──
  try {
    await settleRental(resolvedOrderId, record, returnDeviceId, batteryId);
    console.log(`[WEBHOOK SUCCESS] Order updated to completed. Final Cost: ${record.billing?.chargeAmountEur || 0} EUR`);
  } catch (err) {
    console.error(`[WEBHOOK RETURN] Settlement threw error:`, err.message);
    // Even if settlement threw, the record may have been partially updated.
    // Force the status to completed so the timer stops.
    record.status = 'completed';
    record.endTime = now.toISOString();
    if (!record.billing) {
      record.billing = { error: err.message, chargeAmountEur: 0, releasedAmountEur: 30 };
    }
    rentalRecords.set(resolvedOrderId, record);
    console.log(`[WEBHOOK RETURN] FORCED status=completed due to settlement error. Timer will stop.`);
  }

  res.json({ code: 0, msg: 'success' });
});

// ── 7c. GET /api/rent/status/:orderId — Full status endpoint for frontend polling
// Returns rental status including billing info when completed.
// Supports both tradeNo (Factory order) and session-based lookups.
//
// CRITICAL DESIGN: This endpoint does NOT rely on Factory webhooks for return detection.
// It actively queries the Factory API /rent/order/query on EVERY poll to check if the
// battery has been returned. This is the most reliable approach because:
// 1. Factory webhooks may not be sent (or sent to wrong URL, or lost during Render sleep)
// 2. Factory may send form-urlencoded payloads we can't predict
// 3. The Factory's /rent/order/query returns the current order status directly
app.get('/api/rent/status/:orderId', async (req, res) => {
  const orderId = req.params.orderId;
  console.log(`[STATUS POLL] Querying status for orderId=${orderId}`);

  // ── Check our local rental records first ──
  const record = rentalRecords.get(orderId);

  if (record) {
    console.log(`[STATUS POLL] Found local record: status=${record.status}, hasBilling=${!!record.billing}`);

    // If still active, query Factory API for latest status EVERY TIME
    // This is the primary return detection mechanism — NOT webhooks.
    if (record.status === 'active') {
      try {
        const factoryRes = await factoryApi.post('/rent/order/query', null, {
          params: { tradeNo: orderId },
        });

        // ── Log FULL Factory response for debugging ──
        console.log(`[STATUS POLL] Factory /rent/order/query FULL response:`, JSON.stringify(factoryRes.data, null, 2));

        const factoryData = factoryRes.data?.data;
        const factoryCode = factoryRes.data?.code;
        const factoryMsg = factoryRes.data?.msg;

        // ── Check callback data too ──
        const callbackData = rentalResults.get(orderId);
        if (callbackData) {
          console.log(`[STATUS POLL] Callback data stored:`, JSON.stringify(callbackData));
        }

        // ── RETURN DETECTION LOGIC ──
        // The Factory uses numeric status codes in /rent/order/query response.
        // We check multiple possible indicators that the battery was returned.
        //
        // Factory callbackResult shows: {"status":"1", "tradeNo":"..."} 
        // status "1" = active/rented. Other statuses likely indicate return.
        //
        // We also check the Factory's order/query response data for return indicators.
        let factorySaysReturned = false;
        let returnReason = '';

        if (factoryData) {
          // ── Check 1: Numeric/string status codes ──
          // Factory may use: 0=completed/returned, 2=returned, 3=ended, etc.
          // If status is NOT "1" (active), it likely means returned.
          const fStatus = String(factoryData.status ?? factoryData.orderStatus ?? factoryData.state ?? factoryData.order_status ?? '').trim();
          if (fStatus && fStatus !== '1' && fStatus !== '') {
            // Any status that's not "1" (active) is likely a return/end state
            factorySaysReturned = true;
            returnReason = `Factory status="${fStatus}" (not "1"=active)`;
          }

          // ── Check 2: English keywords (backup) ──
          if (!factorySaysReturned) {
            const returnKeywords = ['return', 'returned', 'end', 'ended', 'finish', 'finished', 'complete', 'completed', 'close', 'closed'];
            if (returnKeywords.some(kw => fStatus.toLowerCase().includes(kw))) {
              factorySaysReturned = true;
              returnReason = `Factory status contains return keyword: "${fStatus}"`;
            }
          }

          // ── Check 3: Return time fields ──
          if (!factorySaysReturned) {
            const hasReturnTime = factoryData.returnTime || factoryData.endTime || factoryData.return_time || factoryData.end_time || factoryData.closeTime || factoryData.close_time;
            if (hasReturnTime) {
              factorySaysReturned = true;
              returnReason = `Factory has returnTime/endTime: ${JSON.stringify(hasReturnTime)}`;
            }
          }

          // ── Check 4: Battery position indicates returned ──
          // If the battery is back in a slot, the order is done
          if (!factorySaysReturned && factoryData.batteryStatus) {
            const bStatus = String(factoryData.batteryStatus).toLowerCase();
            if (bStatus.includes('return') || bStatus.includes('slot') || bStatus.includes('in')) {
              factorySaysReturned = true;
              returnReason = `Factory batteryStatus="${factoryData.batteryStatus}"`;
            }
          }
        }

        // ── Check 5: Callback status changed from "1" to something else ──
        if (!factorySaysReturned && callbackData) {
          const cbStatus = String(callbackData.status ?? '').trim();
          if (cbStatus && cbStatus !== '1' && cbStatus !== '') {
            factorySaysReturned = true;
            returnReason = `Callback status="${cbStatus}" (not "1"=active)`;
          }
        }

        // ── Check 6: Factory code indicates order not found / expired (non-zero and not success) ──
        // If the order query returns a non-zero code, the order may have been closed
        if (!factorySaysReturned && factoryCode !== undefined && factoryCode !== 0) {
          // Code 0 = success/active. Non-zero might mean the order is closed/returned/expired
          // But we need to be careful — some non-zero codes mean "query failed", not "returned"
          // Only treat as returned if the code suggests the order is done
          if (factoryCode === 2004 || factoryCode === 2005 || factoryCode === 2006) {
            factorySaysReturned = true;
            returnReason = `Factory code=${factoryCode} (order closed/not found)`;
          }
        }

        if (factorySaysReturned) {
          console.log(`[STATUS POLL] *** RETURN DETECTED! Reason: ${returnReason}. Triggering settlement... ***`);
          const returnDeviceId = factoryData?.returnDeviceId || factoryData?.return_device_id || factoryData?.cabinetId || factoryData?.device_id || record.deviceId;
          const batteryId = factoryData?.batteryId || factoryData?.battery_id || factoryData?.batterySn || record.batteryId || null;
          await settleRental(orderId, record, returnDeviceId, batteryId);
          console.log(`[STATUS POLL] Settlement complete. Record status is now: ${record.status}`);
        } else {
          console.log(`[STATUS POLL] Battery still active (factory status="${factoryData?.status ?? 'N/A'}", code=${factoryCode})`);
        }
      } catch (err) {
        console.warn(`[STATUS POLL] Factory query failed (non-fatal):`, err.message);
      }
    }

    // ── Build response with top-level totalDuration and finalCost for frontend ──
    const billing = record.billing;
    const startTimeMs = new Date(record.startTime).getTime();
    const nowMs = Date.now();
    const endTimeMs = record.endTime ? new Date(record.endTime).getTime() : nowMs;

    // For active rentals, duration is live; for completed, it's frozen at settlement time
    const totalDurationMs = record.status === 'completed' ? (endTimeMs - startTimeMs) : (nowMs - startTimeMs);
    const totalDurationSeconds = Math.floor(totalDurationMs / 1000);
    const totalDurationMinutes = Math.floor(totalDurationSeconds / 60);
    const durationHours = Math.floor(totalDurationMinutes / 60);
    const remainingMinutes = totalDurationMinutes % 60;
    const remainingSeconds = totalDurationSeconds % 60;

    const durationDisplay = record.status === 'completed' && billing
      ? billing.durationDisplay
      : `${String(durationHours).padStart(2, '0')}:${String(remainingMinutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;

    const finalCost = billing ? billing.chargeAmountEur : 0;

    return res.json({
      success: true,
      orderId,
      tradeNo: record.tradeNo,
      deviceId: record.deviceId,
      status: record.status,                 // 'active' | 'completed' | 'failed'
      startTime: record.startTime,
      endTime: record.endTime,
      // ── Top-level fields for frontend polling ──
      totalDuration: durationDisplay,
      totalDurationMs,
      totalDurationSeconds,
      finalCost,
      finalCostDisplay: `${finalCost.toFixed(2).replace('.', ',')} \u20ac`,
      // ── Full billing breakdown (available when completed) ──
      billing: billing,
      depositReleased: billing ? billing.releasedAmountEur : 0,
      depositReleasedDisplay: billing ? `${billing.releasedAmountEur.toFixed(2).replace('.', ',')} \u20ac` : null,
      callbackResult: rentalResults.get(orderId) || null,
    });
  }

  // ── Fallback: query Factory API directly if no local record ──
  // This happens when Render restarts (free tier sleep) and loses in-memory data.
  // We reconstruct a minimal record from Factory's response and check for return.
  console.log(`[STATUS POLL] No local record for orderId=${orderId}, querying Factory...`);
  try {
    const response = await factoryApi.post('/rent/order/query', null, {
      params: { tradeNo: orderId },
    });

    console.log(`[STATUS POLL] Factory fallback response:`, JSON.stringify(response.data, null, 2));

    const factoryData = response.data?.data;
    const factoryCode = response.data?.code;
    const callbackData = rentalResults.get(orderId);

    // ── Determine Factory order status ──
    const factoryStatus = String(factoryData?.status ?? factoryData?.orderStatus ?? factoryData?.state ?? '').trim();
    const callbackStatus = String(callbackData?.status ?? '').trim();

    // Status "1" = active/rented. Empty or other = unknown/returned
    const isActive = factoryStatus === '1' || (factoryStatus === '' && factoryCode === 0 && !callbackStatus);

    // ── Check if Factory indicates the battery was returned ──
    // (same logic as above, but for records that only exist in Factory, not locally)
    let factorySaysReturned = false;
    let returnReason = '';

    // Check callback status: if it changed from "1" to something else
    if (callbackStatus && callbackStatus !== '1' && callbackStatus !== '') {
      factorySaysReturned = true;
      returnReason = `Callback status="${callbackStatus}" (not "1"=active)`;
    }

    // Check Factory data status
    if (!factorySaysReturned && factoryStatus && factoryStatus !== '1' && factoryStatus !== '') {
      const returnKeywords = ['return', 'returned', 'end', 'ended', 'finish', 'finished', 'complete', 'completed', 'close', 'closed'];
      if (returnKeywords.some(kw => factoryStatus.toLowerCase().includes(kw))) {
        factorySaysReturned = true;
        returnReason = `Factory status="${factoryStatus}" (return keyword)`;
      } else {
        // Non-"1" numeric status = likely returned
        factorySaysReturned = true;
        returnReason = `Factory status="${factoryStatus}" (not "1"=active)`;
      }
    }

    // Check return time fields
    if (!factorySaysReturned && factoryData) {
      const hasReturnTime = factoryData.returnTime || factoryData.endTime || factoryData.return_time || factoryData.end_time || factoryData.closeTime;
      if (hasReturnTime) {
        factorySaysReturned = true;
        returnReason = `Factory has returnTime/endTime`;
      }
    }

    // Check Factory error codes
    if (!factorySaysReturned && factoryCode !== undefined && factoryCode !== 0) {
      if (factoryCode === 2004 || factoryCode === 2005 || factoryCode === 2006) {
        factorySaysReturned = true;
        returnReason = `Factory code=${factoryCode} (order closed/not found)`;
      }
    }

    // ── If returned and we have Factory data, reconstruct a record and settle ──
    if (factorySaysReturned) {
      console.log(`[STATUS POLL] *** RETURN DETECTED in fallback! Reason: ${returnReason}. Reconstructing record and settling... ***`);

      // Reconstruct a minimal record from Factory data
      // We may not have the original startTime, so use callback timestamp as approximation
      const callbackTime = callbackData?.timestamp ? new Date(callbackData.timestamp).toISOString() : new Date().toISOString();
      const startTime = factoryData?.createTime || factoryData?.create_time || factoryData?.rentTime || factoryData?.rent_time || callbackTime;
      const reconstructedRecord = {
        tradeNo: orderId,
        deviceId: factoryData?.deviceId || factoryData?.device_id || factoryData?.cabinetId || 'UNKNOWN',
        batteryId: factoryData?.batteryId || factoryData?.battery_id || factoryData?.batterySn || null,
        paymentIntentId: null, // We don't have this — Stripe capture will be skipped
        startTime,
        endTime: null,
        status: 'active',
        billing: null,
        createdAt: startTime,
      };

      console.log(`[STATUS POLL] Reconstructed record: startTime=${startTime}, deviceId=${reconstructedRecord.deviceId}`);

      // Store it so settleRental can find and update it
      rentalRecords.set(orderId, reconstructedRecord);

      try {
        const returnDeviceId = factoryData?.returnDeviceId || factoryData?.return_device_id || factoryData?.cabinetId || reconstructedRecord.deviceId;
        const batteryId = factoryData?.batteryId || factoryData?.battery_id || null;
        await settleRental(orderId, reconstructedRecord, returnDeviceId, batteryId);
        console.log(`[STATUS POLL] Fallback settlement complete. Status: ${reconstructedRecord.status}`);

        // Return the completed record
        const billing = reconstructedRecord.billing;
        const startTimeMs = new Date(reconstructedRecord.startTime).getTime();
        const endTimeMs = reconstructedRecord.endTime ? new Date(reconstructedRecord.endTime).getTime() : Date.now();
        const totalDurationSeconds = Math.floor((endTimeMs - startTimeMs) / 1000);

        return res.json({
          success: true,
          orderId,
          tradeNo: orderId,
          deviceId: reconstructedRecord.deviceId,
          status: 'completed',
          startTime: reconstructedRecord.startTime,
          endTime: reconstructedRecord.endTime,
          totalDuration: billing?.durationDisplay || `${Math.floor(totalDurationSeconds / 3600)} h ${Math.floor((totalDurationSeconds % 3600) / 60)} min`,
          totalDurationSeconds,
          finalCost: billing?.chargeAmountEur || 0,
          finalCostDisplay: `${(billing?.chargeAmountEur || 0).toFixed(2).replace('.', ',')} \u20ac`,
          billing,
          depositReleased: billing?.releasedAmountEur || 0,
          callbackResult: callbackData,
          note: 'Record reconstructed from Factory API after server restart',
        });
      } catch (settleErr) {
        console.error(`[STATUS POLL] Fallback settlement failed:`, settleErr.message);
        // Still return completed so timer stops
        return res.json({
          success: true,
          orderId,
          status: 'completed',
          finalCost: 0,
          finalCostDisplay: '0,00 \u20ac',
          billing: { error: settleErr.message, chargeAmountEur: 0, releasedAmountEur: 30 },
          note: 'Settlement failed but marked completed to stop timer',
        });
      }
    }

    // ── If still active, return active status ──
    return res.json({
      success: response.data.code === 0,
      tradeNo: orderId,
      status: isActive ? 'active' : 'unknown',
      factoryStatus,
      message: response.data.msg,
      callbackResult: callbackData,
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

// ── 9. GET /api/debug/orders — Debug endpoint: dump all in-memory rental records
// Returns ALL rental records (both active and completed) with full identifier details.
// Use this to inspect exactly what identifiers (deviceId, batteryId, orderId) are being
// saved when a rental starts, and to diagnose webhook matching failures.
app.get('/api/debug/orders', (req, res) => {
  const records = [];
  const activeCount = { active: 0, completed: 0, failed: 0, other: 0 };

  for (const [tradeNo, rec] of rentalRecords.entries()) {
    records.push({
      tradeNo,
      orderId: rec.orderId || tradeNo,
      deviceId: rec.deviceId || null,
      batteryId: rec.batteryId || null,
      factoryOrderId: rec.factoryOrderId || null,
      paymentIntentId: rec.paymentIntentId || null,
      startTime: rec.startTime || null,
      endTime: rec.endTime || null,
      status: rec.status || 'unknown',
      returnDeviceId: rec.returnDeviceId || null,
      hasBilling: !!rec.billing,
      billing: rec.billing || null,
      createdAt: rec.createdAt || null,
    });

    if (rec.status === 'active') activeCount.active++;
    else if (rec.status === 'completed') activeCount.completed++;
    else if (rec.status === 'failed') activeCount.failed++;
    else activeCount.other++;
  }

  // Also dump callback results map for debugging
  const callbacks = [];
  for (const [tradeNo, data] of rentalResults.entries()) {
    callbacks.push({ tradeNo, callbackData: data });
  }

  res.json({
    totalRecords: records.length,
    statusBreakdown: activeCount,
    totalCallbacks: callbacks.length,
    records,
    callbacks,
    serverTime: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
  });
});

// ── 10. POST /api/rent/force-complete — Admin force-complete endpoint
// Manually triggers settlement for an order, bypassing the physical hardware webhook.
// This allows testing the frontend redirect and billing logic independently.
// Accepts: { orderId: "tradeNo" }
// Executes: settleRental() → calculates duration, captures Stripe, sets status=completed
app.post('/api/rent/force-complete', async (req, res) => {
  const { orderId } = req.body;

  console.log('[FORCE COMPLETE] Request received for orderId:', orderId);

  if (!orderId) {
    return res.status(400).json({
      success: false,
      error: 'orderId is required',
    });
  }

  // ── Try to find the record in memory ──
  let record = rentalRecords.get(orderId);

  // ── If not in memory, try to find by partial match (orderId might be truncated) ──
  if (!record) {
    console.log('[FORCE COMPLETE] No exact match, trying partial lookup...');
    for (const [tn, rec] of rentalRecords.entries()) {
      if (tn.includes(orderId) || orderId.includes(tn) ||
          (rec.batteryId && rec.batteryId === orderId) ||
          (rec.factoryOrderId && rec.factoryOrderId === orderId)) {
        record = rec;
        console.log(`[FORCE COMPLETE] Found via partial match: tradeNo=${tn}`);
        orderId = tn; // Use the actual key
        break;
      }
    }
  }

  if (!record) {
    console.warn(`[FORCE COMPLETE] No rental record found for orderId=${orderId}`);
    return res.status(404).json({
      success: false,
      error: `No rental record found for orderId: ${orderId}`,
      hint: 'Use GET /api/debug/orders to see all stored records.',
    });
  }

  if (record.status === 'completed') {
    console.log(`[FORCE COMPLETE] Order ${orderId} is already completed.`);
    return res.json({
      success: true,
      message: 'Order was already completed',
      orderId,
      status: 'completed',
      billing: record.billing,
    });
  }

  // ── Run settlement ──
  try {
    console.log(`[FORCE COMPLETE] Triggering settlement for orderId=${orderId}...`);
    console.log(`[FORCE COMPLETE] Record: deviceId=${record.deviceId}, batteryId=${record.batteryId || 'N/A'}, paymentIntentId=${record.paymentIntentId || 'NONE'}`);

    const billing = await settleRental(orderId, record, record.deviceId, record.batteryId);

    console.log(`[FORCE COMPLETE] Settlement complete. Charge: ${billing.chargeAmountEur} EUR`);

    res.json({
      success: true,
      message: 'Order force-completed successfully',
      orderId,
      status: 'completed',
      billing,
      finalCost: billing.chargeAmountEur,
      finalCostDisplay: `${billing.chargeAmountEur.toFixed(2).replace('.', ',')} €`,
      totalDuration: billing.durationDisplay,
    });
  } catch (err) {
    console.error(`[FORCE COMPLETE] Settlement failed:`, err.message);

    // Even if settlement threw, force the status to completed
    record.status = 'completed';
    record.endTime = new Date().toISOString();
    if (!record.billing) {
      record.billing = { error: err.message, chargeAmountEur: 0, releasedAmountEur: 30 };
    }
    rentalRecords.set(orderId, record);

    res.json({
      success: true,
      message: 'Order force-completed (settlement had errors but status is completed)',
      orderId,
      status: 'completed',
      billing: record.billing,
      error: err.message,
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
