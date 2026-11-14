import { useState, useEffect } from 'react';
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

  useEffect(() => {
    if (!orderId) {
      setError("Aucun identifiant de commande trouv.");
      setLoading(false);
      return;
    }

    const fetchSummary = async () => {
      try {
        const { data } = await api.get(`/api/rent/status/${orderId}`);

        if (data.success && data.status === 'completed') {
          setRecord(data);
          setLoading(false);
        } else if (data.success && data.status === 'active') {
          // Rental still active — keep waiting
          setError(null);
          setLoading(true);
        } else {
          setError(data.message || 'Commande introuvable.');
          setLoading(false);
        }
      } catch (err) {
        const errMsg = err.code === 'ECONNABORTED'
          ? 'Le serveur met trop de temps  rpondre.'
          : (err.response?.data?.error || err.message);
        setError(errMsg);
        setLoading(false);
      }
    };

    // Initial fetch
    fetchSummary();

    // Poll every 5s if still loading (rental still active)
    const pollInterval = setInterval(() => {
      if (!loading) {
        clearInterval(pollInterval);
        return;
      }
      fetchSummary();
    }, 5000);

    // Stop polling after 5 minutes
    const timeout = setTimeout(() => {
      clearInterval(pollInterval);
      if (loading) {
        setError('Dlai dpass. La location est peut-tre toujours en cours.');
        setLoading(false);
      }
    }, 300000);

    return () => {
      clearInterval(pollInterval);
      clearTimeout(timeout);
    };
  }, [orderId]);

  // ── Loading state ──
  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-green-50 flex items-center justify-center p-6">
        <div className="bg-white p-8 rounded-3xl shadow-xl w-full max-w-md text-center">
          <div className="inline-block w-16 h-16 border-4 border-green-200 border-t-green-500 rounded-full animate-spin mb-6" />
          <h1 className="text-xl font-bold text-gray-700 mb-2">En attente du retour...</h1>
          <p className="text-gray-500 text-sm">
            Veuillez remettre la batterie dans la station pour finaliser la location.
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
          <div className="text-6xl mb-4">...</div>
          <h1 className="text-xl font-bold text-red-600 mb-2">Erreur</h1>
          <p className="text-gray-600 text-sm mb-6">{error}</p>
          <button
            onClick={() => navigate('/')}
            className="w-full bg-blue-500 text-white py-3 rounded-xl font-bold hover:bg-blue-600 transition"
          >
            Retour  l'accueil
          </button>
        </div>
      </div>
    );
  }

  // ── Success receipt ──
  const billing = record?.billing;
  const sym = billing?.currency === 'EUR' ? '' : (billing?.currencySymbol || '');
  const chargeDisplay = billing ? `${billing.chargeAmountEur.toFixed(2).replace('.', ',')} ${sym}` : '0,00 ';
  const releasedDisplay = billing ? `${billing.releasedAmountEur.toFixed(2).replace('.', ',')} ${sym}` : '30,00 ';
  const durationDisplay = billing?.durationDisplay || '0 h 0 min';

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 to-emerald-100 flex items-center justify-center p-6 pt-16">
      <div className="bg-white p-8 rounded-3xl shadow-2xl w-full max-w-md">
        {/* ── Success checkmark ── */}
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center w-20 h-20 bg-green-500 rounded-full mb-4 shadow-lg">
            <svg className="w-10 h-10 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-green-700">
            Batterie retourne avec succs
          </h1>
          <p className="text-gray-500 text-sm mt-2">
            Votre location est termine. Merci !
          </p>
        </div>

        {/* ── Receipt details ── */}
        <div className="bg-gray-50 rounded-2xl p-5 mb-6 space-y-4">
          {/* Duration */}
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-2">
              <span className="text-2xl"></span>
              <span className="text-gray-600 text-sm font-medium">Temps d'utilisation</span>
            </div>
            <span className="text-gray-900 font-bold text-lg">{durationDisplay}</span>
          </div>

          {/* Divider */}
          <div className="border-t border-gray-200" />

          {/* Amount charged */}
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-2">
              <span className="text-2xl"></span>
              <span className="text-gray-600 text-sm font-medium">Montant factur</span>
            </div>
            <div className="text-right">
              <span className="text-gray-900 font-bold text-lg">{chargeDisplay}</span>
              {billing?.chargeAmountCents === 0 && (
                <p className="text-green-500 text-xs">Gratuit (priode essai)</p>
              )}
            </div>
          </div>

          {/* Divider */}
          <div className="border-t border-gray-200" />

          {/* Deposit released */}
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-2">
              <span className="text-2xl"></span>
              <span className="text-gray-600 text-sm font-medium">Caution libre</span>
            </div>
            <span className="text-green-600 font-bold text-lg">{releasedDisplay}</span>
          </div>
        </div>

        {/* ── Info note ── */}
        <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 mb-6">
          <p className="text-blue-700 text-xs text-center">
            La caution restante a t automatiquement libre sur votre carte.
            Selon votre banque, le remboursement peut prendre 3-5 jours ouvrs.
          </p>
        </div>

        {/* ── Order ID ── */}
        <p className="text-gray-400 text-xs text-center mb-4">
          N de commande: <span className="font-mono">{orderId}</span>
        </p>

        {/* ── Return button ── */}
        <button
          onClick={() => navigate('/')}
          className="w-full bg-green-500 text-white py-4 rounded-xl font-bold text-lg hover:bg-green-600 transition shadow-lg"
        >
          Retour  l'accueil
        </button>
      </div>
    </div>
  );
}
