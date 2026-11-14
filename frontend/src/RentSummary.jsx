import { useState, useEffect, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import axios from 'axios';

const API_BASE = import.meta.env.VITE_API_URL || 'https://powerbank-app-im73.onrender.com';
const api = axios.create({ baseURL: API_BASE, timeout: 30000 });

export default function RentSummary() {
  const [searchParams] = useSearchParams();
  const orderId = searchParams.get('orderId') || searchParams.get('tradeNo');
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [record, setRecord] = useState(null);
  const [error, setError] = useState(null);
  const loadingRef = useRef(true); // avoids stale closure in setInterval

  useEffect(() => {
    if (!orderId) {
      setError("Aucun identifiant de commande trouve.");
      setLoading(false);
      loadingRef.current = false;
      return;
    }

    const fetchSummary = async () => {
      try {
        const { data } = await api.get(`/api/rent/status/${orderId}`);

        if (data.status === 'completed') {
          setRecord(data);
          setLoading(false);
          loadingRef.current = false;
        } else if (data.status === 'active') {
          // Rental still active — redirect to active rental page
          navigate(`/rent/active?orderId=${orderId}&deviceId=${data.deviceId || ''}`);
        } else {
          setError(data.message || 'Commande introuvable.');
          setLoading(false);
          loadingRef.current = false;
        }
      } catch (err) {
        const errMsg = err.code === 'ECONNABORTED'
          ? 'Le serveur met trop de temps a repondre.'
          : (err.response?.data?.error || err.message);
        setError(errMsg);
        setLoading(false);
        loadingRef.current = false;
      }
    };

    // Initial fetch
    fetchSummary();

    // Poll every 5s if still loading (settlement may be in progress)
    const pollInterval = setInterval(() => {
      if (!loadingRef.current) {
        clearInterval(pollInterval);
        return;
      }
      fetchSummary();
    }, 5000);

    // Stop polling after 5 minutes
    const timeout = setTimeout(() => {
      clearInterval(pollInterval);
      if (loadingRef.current) {
        setError('Delai depasse. La location est peut-etre toujours en cours.');
        setLoading(false);
        loadingRef.current = false;
      }
    }, 300000);

    return () => {
      clearInterval(pollInterval);
      clearTimeout(timeout);
    };
  }, [orderId, navigate]);

  // ── Loading state ──
  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-green-50 flex items-center justify-center p-6">
        <div className="bg-white p-8 rounded-3xl shadow-xl w-full max-w-md text-center">
          <div className="inline-block w-16 h-16 border-4 border-green-200 border-t-green-500 rounded-full animate-spin mb-6" />
          <h1 className="text-xl font-bold text-gray-700 mb-2">Finalisation du paiement...</h1>
          <p className="text-gray-500 text-sm">
            Veuillez patienter pendant le calcul du montant.
          </p>
          <p className="text-gray-400 text-xs mt-4">
            Commande: <span className="font-mono">{orderId}</span>
          </p>
        </div>
      </div>
    );
  }

  // ── Error state ──
  if (error) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-red-50 to-orange-50 flex items-center justify-center p-6">
        <div className="bg-white p-8 rounded-3xl shadow-xl w-full max-w-md text-center">
          <div className="text-5xl mb-4">⚠️</div>
          <h1 className="text-xl font-bold text-red-600 mb-2">Erreur</h1>
          <p className="text-gray-600 text-sm mb-6">{error}</p>
          <button
            onClick={() => navigate('/')}
            className="w-full bg-blue-500 text-white py-3 rounded-xl font-bold hover:bg-blue-600 transition"
          >
            Retour a la carte
          </button>
        </div>
      </div>
    );
  }

  // ── Success receipt ──
  const billing = record?.billing;
  const chargeAmount = billing ? billing.chargeAmountEur : (record?.finalCost || 0);
  const releasedAmount = billing ? billing.releasedAmountEur : (record?.depositReleased || 30 - chargeAmount);
  const durationDisplay = billing?.durationDisplay || record?.totalDuration || '0 h 0 min';
  const isFree = chargeAmount === 0;

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 to-emerald-100 flex items-center justify-center p-6 pt-16">
      <div className="bg-white p-8 rounded-3xl shadow-2xl w-full max-w-md">

        {/* ── Success header ── */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-20 h-20 bg-green-500 rounded-full mb-4 shadow-lg">
            <svg className="w-10 h-10 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-green-700">
            Batterie retournee avec succes
          </h1>
          <p className="text-gray-500 text-sm mt-2">
            Votre location est terminee. Merci !
          </p>
        </div>

        {/* ── Receipt details ── */}
        <div className="bg-gray-50 rounded-2xl p-6 mb-6 space-y-5">

          {/* Duration */}
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-indigo-100 rounded-full flex items-center justify-center">
                <svg className="w-5 h-5 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <circle cx="12" cy="12" r="9" />
                  <path strokeLinecap="round" d="M12 7v5l3 2" />
                </svg>
              </div>
              <span className="text-gray-600 text-sm font-medium">Temps total de location</span>
            </div>
            <span className="text-gray-900 font-bold text-lg">{durationDisplay}</span>
          </div>

          {/* Divider */}
          <div className="border-t border-gray-200" />

          {/* Amount charged */}
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-blue-100 rounded-full flex items-center justify-center">
                <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1" />
                </svg>
              </div>
              <span className="text-gray-600 text-sm font-medium">Montant facture</span>
            </div>
            <div className="text-right">
              <span className="text-gray-900 font-bold text-lg">
                {chargeAmount.toFixed(2).replace('.', ',')} €
              </span>
              {isFree && (
                <p className="text-green-500 text-xs font-semibold">Gratuit (periode d'essai)</p>
              )}
            </div>
          </div>

          {/* Divider */}
          <div className="border-t border-gray-200" />

          {/* Deposit released */}
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-green-100 rounded-full flex items-center justify-center">
                <svg className="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <span className="text-gray-600 text-sm font-medium">Caution libérée</span>
            </div>
            <span className="text-green-600 font-bold text-lg">
              {releasedAmount.toFixed(2).replace('.', ',')} €
            </span>
          </div>

          {/* Cross-station indicator */}
          {billing?.crossStationReturn && (
            <>
              <div className="border-t border-gray-200" />
              <div className="flex justify-between items-center">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-purple-100 rounded-full flex items-center justify-center">
                    <svg className="w-5 h-5 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                      <circle cx="15" cy="11" r="3" />
                    </svg>
                  </div>
                  <span className="text-gray-600 text-sm font-medium">Retour inter-stations</span>
                </div>
                <span className="text-purple-600 text-xs font-semibold">
                  {billing.dispensingDeviceId} → {billing.returnDeviceId}
                </span>
              </div>
            </>
          )}
        </div>

        {/* ── Pricing breakdown ── */}
        {!isFree && billing && (
          <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 mb-6">
            <p className="text-blue-700 text-xs text-center">
              {billing.pricePerHour} €/heure · {billing.freeMinutes} min gratuites · plafond {billing.dailyMaxPrice || 30} €/jour
            </p>
          </div>
        )}

        {/* ── Bank refund note ── */}
        <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 mb-6">
          <p className="text-blue-700 text-xs text-center">
            La caution restante a ete automatiquement libérée sur votre carte.
            Selon votre banque, le remboursement peut prendre 3-5 jours ouvres.
          </p>
        </div>

        {/* ── Order ID ── */}
        <p className="text-gray-400 text-xs text-center mb-4">
          N° de commande: <span className="font-mono">{orderId}</span>
        </p>

        {/* ── Return button ── */}
        <button
          onClick={() => navigate('/')}
          className="w-full bg-green-500 text-white py-4 rounded-xl font-bold text-lg hover:bg-green-600 transition shadow-lg"
        >
          Retour à l'accueil
        </button>
      </div>
    </div>
  );
}
