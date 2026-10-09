import { useState, useEffect, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { CardElement, useStripe, useElements } from '@stripe/react-stripe-js';
import axios from 'axios';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000';

export default function RentCheckout() {
  const [searchParams] = useSearchParams();
  const deviceId = searchParams.get('deviceId');
  const navigate = useNavigate();
  const stripe = useStripe();
  const elements = useElements();

  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [cabinet, setCabinet] = useState(null);
  const pollRef = useRef(null);

  // Fetch cabinet info from backend (which calls Factory API)
  useEffect(() => {
    if (deviceId) {
      axios.get(`${API_BASE}/api/cabinet/${deviceId}`)
        .then(res => setCabinet(res.data))
        .catch(() => setStatus('Erreur de chargement'));
    }
    // Cleanup polling on unmount
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [deviceId]);

  // Poll rental order status
  const pollOrderStatus = (tradeNo, paymentIntentId) => {
    let attempts = 0;
    const maxAttempts = 30; // 30 × 2s = 60s timeout

    pollRef.current = setInterval(async () => {
      attempts++;
      try {
        const { data } = await axios.post(`${API_BASE}/api/rent/status`, { tradeNo });

        if (data.success) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          setStatus('✅ Batterie déverrouillée ! Retirez-la maintenant.');
          setLoading(false);
        } else if (attempts >= maxAttempts) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          // Timeout — release the Stripe hold
          if (paymentIntentId) {
            try { await axios.post(`${API_BASE}/api/rent/cancel-hold`, { paymentIntentId }); } catch (e) { /* ignore */ }
          }
          setStatus('❌ Délai dépassé. La caution a été libérée.');
          setLoading(false);
        } else {
          setStatus(`⏳ Déverrouillage en cours... (${attempts}/${maxAttempts})`);
        }
      } catch (err) {
        // Keep polling on transient errors
        if (attempts >= maxAttempts) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          setStatus('❌ Erreur de vérification du statut.');
          setLoading(false);
        }
      }
    }, 2000);
  };

  const handleRent = async (e) => {
    e.preventDefault();
    if (!stripe || !elements) return;
    setLoading(true);
    setStatus('Création de la pré-autorisation...');

    try {
      // Step 1: Stripe pre-authorization (€30 hold)
      const { data: { clientSecret, paymentIntentId } } = await axios.post(`${API_BASE}/api/rent/preauth`);
      setStatus('Paiement autorisé. Déverrouillage en cours...');

      // Step 2: Create rental order via Factory API
      const ejectRes = await axios.post(`${API_BASE}/api/rent/eject`, { deviceId, paymentIntentId });

      if (ejectRes.data.success && ejectRes.data.tradeNo) {
        // Step 3: Poll factory for rental order status
        pollOrderStatus(ejectRes.data.tradeNo, paymentIntentId);
      } else {
        setStatus('❌ Échec: ' + (ejectRes.data.message || 'Erreur inconnue'));
        setLoading(false);
      }
    } catch (error) {
      setStatus('❌ Échec: ' + (error.response?.data?.message || error.response?.data?.error || error.message));
      setLoading(false);
    }
  };

  if (!cabinet) return <div className="p-10 text-center text-black">Chargement...</div>;

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
          {!cabinet.isOnline && (
            <p className="text-sm text-red-500 mt-1">⚠️ Hors ligne</p>
          )}
        </div>

        <form onSubmit={handleRent}>
          <div className="mb-6 border p-3 rounded-lg bg-white">
            <CardElement options={{ hidePostalCode: true }} />
          </div>
          <button
            type="submit"
            disabled={!stripe || loading || !cabinet.isRentable}
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
