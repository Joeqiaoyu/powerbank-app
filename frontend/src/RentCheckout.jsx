import { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { CardElement, useStripe, useElements } from '@stripe/react-stripe-js';
import axios from 'axios';

const API_BASE = import.meta.env.VITE_API_URL || 'https://powerbank-app-im73.onrender.com';
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
        message: 'Le serveur peut être en cours de réveil. Réessayez dans quelques instants.',
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
      const { data: { clientSecret, paymentIntentId } } = await api.post('/api/rent/preauth');

      const { error: confirmError, paymentIntent: confirmedPI } = await stripe.confirmCardPayment(clientSecret, {
        payment_method: { card: elements.getElement(CardElement) },
        return_url: `${window.location.origin}/rent/success?deviceId=${deviceId}`,
      });

      if (confirmError) {
        setStatus('Paiement refusé : ' + confirmError.message);
        setLoading(false);
        return;
      }

      if (confirmedPI.status === 'requires_action' || confirmedPI.status === 'requires_redirect') {
        setStatus('Redirection vers votre banque pour validation...');
        return;
      }

      setStatus('Paiement autorisé. Déverrouillage en cours...');
      const ejectRes = await api.post('/api/rent/eject', { deviceId, paymentIntentId: confirmedPI.id });

      if (ejectRes.data.success && ejectRes.data.tradeNo) {
        const orderId = ejectRes.data.tradeNo;
        navigate(`/rent/active?orderId=${orderId}&deviceId=${deviceId}`);
      } else {
        setStatus('Échec : ' + (ejectRes.data.message || 'Erreur inconnue'));
        setLoading(false);
      }
    } catch (error) {
      const errMsg = error.code === 'ECONNABORTED'
        ? 'Le serveur met trop de temps à répondre. Réessayez.'
        : (error.response?.data?.message || error.response?.data?.error || error.message);
      setStatus('Échec : ' + errMsg);
      setLoading(false);
    }
  };

  if (fetchError) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-6 flex flex-col items-center justify-center pt-20">
        <div className="bg-white p-8 rounded-3xl shadow-xl w-full max-w-md text-center">
          <div className="text-4xl mb-4">⚠️</div>
          <h1 className="text-xl font-bold text-red-600 mb-2">{fetchError.title}</h1>
          <p className="text-gray-600 mb-2 text-sm">{fetchError.message}</p>
          {fetchError.detail && <p className="text-gray-400 mb-6 text-xs">{fetchError.detail}</p>}
          <button
            onClick={fetchCabinet}
            disabled={retrying}
            className="w-full bg-blue-600 text-white py-3 rounded-xl font-bold disabled:opacity-50 min-h-[48px] hover:bg-blue-700 transition"
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

  if (!cabinet) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 flex items-center justify-center">
        <div className="text-center">
          <div className="inline-block w-12 h-12 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin mb-4" />
          <p className="text-gray-500">Chargement des informations de la station...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50 to-indigo-50 p-6 flex flex-col items-center pt-20 pb-12">
      <div className="bg-white rounded-3xl shadow-xl w-full max-w-md overflow-hidden">

        {/* ── Header ── */}
        <div className="bg-gradient-to-r from-blue-600 to-indigo-600 px-6 py-8 text-center">
          <div className="inline-flex items-center justify-center w-14 h-14 bg-white/20 rounded-2xl mb-3 backdrop-blur-sm">
            <svg className="w-7 h-7 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-white mb-1">Location de Batterie</h1>
          <p className="text-blue-100 text-sm">
            Station : <span className="font-mono font-semibold">{deviceId}</span>
            {cabinet.shopName ? ` · ${cabinet.shopName}` : ''}
          </p>
        </div>

        <div className="p-6 space-y-5">

          {/* ── Hardware Specs Card ── */}
          <div className="bg-gradient-to-br from-slate-50 to-gray-50 rounded-2xl p-5 border border-gray-100">
            <p className="text-xs font-bold uppercase tracking-wider text-gray-400 mb-3">Caractéristiques</p>
            <div className="space-y-3">
              <div className="flex items-start gap-3">
                <div className="flex-shrink-0 w-8 h-8 bg-amber-100 rounded-lg flex items-center justify-center">
                  <span className="text-base">⚡</span>
                </div>
                <div>
                  <p className="text-sm font-semibold text-gray-800">Capacité : 6000 mAh</p>
                  <p className="text-xs text-gray-500">Permet 1,5 à 2 charges complètes d'un smartphone</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="flex-shrink-0 w-8 h-8 bg-blue-100 rounded-lg flex items-center justify-center">
                  <span className="text-base">🔌</span>
                </div>
                <div>
                  <p className="text-sm font-semibold text-gray-800">3 Câbles inclus</p>
                  <p className="text-xs text-gray-500">USB-C · Apple Lightning · Micro-USB</p>
                </div>
              </div>
            </div>
          </div>

          {/* ── Pricing Card ── */}
          <div className="bg-gradient-to-br from-emerald-50 to-green-50 rounded-2xl p-5 border border-emerald-100">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-semibold text-gray-700">Tarif</span>
              <span className="text-lg font-bold text-gray-900">1 € <span className="text-sm font-normal text-gray-500">/ heure</span></span>
            </div>
            <div className="bg-emerald-100 rounded-lg px-3 py-2 mb-3">
              <p className="text-emerald-700 text-sm font-bold text-center">
                🎁 Les 5 premières minutes sont offertes !
              </p>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-500">Plafond journalier</span>
              <span className="text-gray-700 font-semibold">30 €</span>
            </div>
            {cabinet.availablePowerBanks > 0 && cabinet.isOnline !== false && (
              <div className="mt-3 flex items-center gap-2 text-emerald-600">
                <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
                <span className="text-xs font-semibold">{cabinet.availablePowerBanks} batterie{cabinet.availablePowerBanks > 1 ? 's' : ''} disponible{cabinet.availablePowerBanks > 1 ? 's' : ''}</span>
              </div>
            )}
            {cabinet.isOnline === false && (
              <p className="text-sm text-orange-500 mt-3">
                ⚠️ La station signale être hors ligne. Vous pouvez tout de même tenter la location.
              </p>
            )}
          </div>

          {/* ── Financial Trust Notice ── */}
          <div className="bg-blue-50 border border-blue-200 rounded-2xl p-4">
            <div className="flex gap-3">
              <div className="flex-shrink-0">
                <div className="w-10 h-10 bg-blue-600 rounded-full flex items-center justify-center">
                  <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                  </svg>
                </div>
              </div>
              <div className="flex-1">
                <p className="text-sm font-bold text-blue-900 mb-1">Caution de 30 €</p>
                <p className="text-xs text-blue-700 leading-relaxed">
                  Il s'agit d'une simple empreinte bancaire (pré-autorisation). Seul le montant réel de votre location sera déduit à la fin. Le reste est automatiquement annulé et libéré lors du retour de la batterie.
                </p>
              </div>
            </div>
          </div>

          {/* ── Stripe Payment Form ── */}
          <form onSubmit={handleRent} className="space-y-4">
            <div className="border-2 border-gray-200 rounded-xl p-4 bg-white focus-within:border-blue-400 transition">
              <CardElement options={{ hidePostalCode: true }} />
            </div>

            <button
              type="submit"
              disabled={!stripe || loading}
              className="w-full bg-blue-600 text-white py-4 rounded-xl font-bold text-base hover:bg-blue-700 transition shadow-lg disabled:opacity-50 disabled:cursor-not-allowed min-h-[48px] flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <span className="inline-block w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Traitement...
                </>
              ) : (
                <>
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                  </svg>
                  Autoriser 30 € et Louer
                </>
              )}
            </button>
          </form>

          {/* ── Status message ── */}
          {status && (
            <div className={`p-3 rounded-xl text-sm text-center ${
              status.includes('Échec') || status.includes('refusé')
                ? 'bg-red-50 text-red-700 border border-red-200'
                : status.includes('autorisé') || status.includes('Déverrouillage')
                ? 'bg-blue-50 text-blue-700 border border-blue-200'
                : 'bg-gray-50 text-gray-700 border border-gray-200'
            }`}>
              {status}
            </div>
          )}

          <button
            onClick={() => navigate('/')}
            className="w-full text-gray-400 hover:text-gray-600 text-sm text-center py-2 transition"
          >
            ← Retour à la carte
          </button>
        </div>
      </div>
    </div>
  );
}
