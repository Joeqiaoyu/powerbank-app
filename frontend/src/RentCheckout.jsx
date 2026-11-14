import { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { CardElement, useStripe, useElements } from '@stripe/react-stripe-js';
import axios from 'axios';

// ── Production-safe env var (no localhost fallback in production) ──
const API_BASE = import.meta.env.VITE_API_URL || 'https://powerbank-app-im73.onrender.com';

// Axios instance with generous timeout for Render free-tier cold starts
const api = axios.create({ baseURL: API_BASE, timeout: 60000 });

export default function RentCheckout() {
  const [searchParams] = useSearchParams();
  const deviceId = searchParams.get('deviceId');
  const navigate = useNavigate();
  const stripe = useStripe();
  const elements = useElements();

  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [cabinet, setCabinet] = useState(null);
  const [fetchError, setFetchError] = useState(null);
  const [retrying, setRetrying] = useState(false);

  // ── Fetch cabinet info with graceful error handling ──
  const fetchCabinet = async () => {
    if (!deviceId) {
      setFetchError({ title: 'Aucun appareil', message: 'Veuillez scanner un QR code ou sélectionner une station.' });
      return;
    }
    setFetchError(null);
    setRetrying(true);
    try {
      const res = await api.get(`/api/cabinet/${deviceId}`);
      setCabinet(res.data);
    } catch (err) {
      console.error('Cabinet fetch error:', err);
      setFetchError({
        title: 'Serveur injoignable',
        message: 'Le serveur peut être en cours de réveil (Render free tier ~50s). Réessayez.',
        detail: err.code === 'ECONNABORTED' ? 'Délai dépassé (timeout 60s)' : (err.message || 'Erreur réseau'),
      });
    } finally {
      setRetrying(false);
    }
  };

  useEffect(() => {
    fetchCabinet();
  }, [deviceId]);

  const handleRent = async (e) => {
    e.preventDefault();
    if (!stripe || !elements) return;
    setLoading(true);
    setStatus('Création de la pré-autorisation...');

    try {
      // Step 1: Stripe pre-authorization (€30 hold)
      const { data: { clientSecret, paymentIntentId } } = await api.post('/api/rent/preauth');

      // Step 2: Confirm the card payment with Stripe
      const { error: confirmError, paymentIntent: confirmedPI } = await stripe.confirmCardPayment(clientSecret, {
        payment_method: { card: elements.getElement(CardElement) },
        return_url: `${window.location.origin}/rent/success?deviceId=${deviceId}`,
      });

      if (confirmError) {
        setStatus('❌ Paiement refusé: ' + confirmError.message);
        setLoading(false);
        return;
      }

      // If the payment requires a redirect (3DS), Stripe handles it.
      if (confirmedPI.status === 'requires_action' || confirmedPI.status === 'requires_redirect') {
        setStatus('Redirection vers votre banque pour validation...');
        return;
      }

      // Step 3: Payment authorized — create rental order via Factory API to pop the battery
      setStatus('Paiement autorisé. Déverrouillage en cours...');
      const ejectRes = await api.post('/api/rent/eject', { deviceId, paymentIntentId: confirmedPI.id });

      if (ejectRes.data.success && ejectRes.data.tradeNo) {
        // Step 4: Redirect to the active rental page with live timer
        const orderId = ejectRes.data.tradeNo;
        navigate(`/rent/active?orderId=${orderId}&deviceId=${deviceId}`);
      } else {
        setStatus('❌ Échec: ' + (ejectRes.data.message || 'Erreur inconnue'));
        setLoading(false);
      }
    } catch (error) {
      const errMsg = error.code === 'ECONNABORTED'
        ? 'Le serveur met trop de temps à répondre. Réessayez.'
        : (error.response?.data?.message || error.response?.data?.error || error.message);
      setStatus('❌ Échec: ' + errMsg);
      setLoading(false);
    }
  };

  // ── Graceful error state (no white screen) ──
  if (fetchError) {
    return (
      <div className="min-h-screen bg-gray-50 p-6 flex flex-col items-center justify-center pt-20">
        <div className="bg-white p-8 rounded-2xl shadow-xl w-full max-w-md text-center">
          <div className="text-4xl mb-4">⚠️</div>
          <h1 className="text-xl font-bold text-red-700 mb-2">{fetchError.title}</h1>
          <p className="text-gray-600 mb-2 text-sm">{fetchError.message}</p>
          <p className="text-gray-400 mb-6 text-xs">{fetchError.detail}</p>
          <button
            onClick={fetchCabinet}
            disabled={retrying}
            className="w-full bg-blue-500 text-white py-3 rounded-xl font-bold disabled:opacity-50"
          >
            {retrying ? 'Réveil du serveur...' : 'Réessayer'}
          </button>
          <button onClick={() => navigate('/')} className="mt-4 text-gray-400 underline text-sm w-full text-center">
            Retour à la carte
          </button>
        </div>
      </div>
    );
  }

  if (!cabinet) return <div className="min-h-screen flex items-center justify-center text-gray-500 text-lg">Chargement...</div>;

  const sym = cabinet.currencySymbol || '€';

  return (
    <div className="min-h-screen bg-gray-50 p-6 flex flex-col items-center pt-20">
      <div className="bg-white p-6 rounded-2xl shadow-xl w-full max-w-md">
        <h1 className="text-2xl font-bold mb-2 text-black">Location de Batterie</h1>
        <p className="text-gray-500 mb-6">
          Station: {deviceId}
          {cabinet.shopName ? ` · ${cabinet.shopName}` : ''}
        </p>

        <div className="bg-blue-50 border border-blue-100 p-4 rounded-xl mb-6">
          <p className="font-semibold text-blue-800">
            Tarif: {cabinet.price} {cabinet.currency} / heure
            {cabinet.freeMinutes > 0 && (
              <span className="text-sm font-normal"> · {cabinet.freeMinutes} min gratuites</span>
            )}
          </p>
          <p className="text-sm text-blue-600 mt-1">
            Caution (pré-autorisation): {sym}{cabinet.deposit}
            {cabinet.dailyMaxPrice > 0 && (
              <span className="text-xs"> · Plafond: {sym}{cabinet.dailyMaxPrice}/jour</span>
            )}
          </p>
          {cabinet.isOnline === false && (
            <p className="text-sm text-orange-500 mt-2">
              ⚠️ Le serveur signale la station hors ligne. Vous pouvez tout de même tenter la location.
            </p>
          )}
          {cabinet.availablePowerBanks === 0 && cabinet.isOnline !== false && (
            <p className="text-sm text-red-500 mt-2">⚠️ Aucune batterie disponible</p>
          )}
        </div>

        <form onSubmit={handleRent}>
          <div className="mb-6 border p-3 rounded-lg bg-white">
            <CardElement options={{ hidePostalCode: true }} />
          </div>
          <button
            type="submit"
            disabled={!stripe || loading}
            className="w-full bg-green-500 text-white py-4 rounded-xl font-bold text-lg disabled:opacity-50"
          >
            {loading ? 'Traitement...' : `Autoriser ${sym}${cabinet.deposit} et Louer`}
          </button>
        </form>

        {status && (
          <div className={`mt-4 p-3 rounded-lg text-sm text-center ${
            status.includes('❌') ? 'bg-red-100 text-red-700' :
            status.includes('✅') ? 'bg-green-100 text-green-700' :
            'bg-gray-100 text-black'
          }`}>
            {status}
          </div>
        )}

        <button onClick={() => navigate('/')} className="mt-6 text-gray-400 underline text-sm w-full text-center">
          Retour à la carte
        </button>
      </div>
    </div>
  );
}
