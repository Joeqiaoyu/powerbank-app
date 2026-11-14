import { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import axios from 'axios';

const API_BASE = import.meta.env.VITE_API_URL || 'https://powerbank-app-im73.onrender.com';
const api = axios.create({ baseURL: API_BASE, timeout: 30000 });

const PRICE_PER_HOUR = 1;
const FREE_MINUTES = 5;
const FREE_SECONDS = FREE_MINUTES * 60;
const DAILY_CAP = 30;

function formatDuration(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatCountdown(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export default function ActiveRental() {
  const [searchParams] = useSearchParams();
  const orderId = searchParams.get('orderId');
  const deviceId = searchParams.get('deviceId');
  const navigate = useNavigate();

  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [rentalStatus, setRentalStatus] = useState('loading');
  const [startTimeMs, setStartTimeMs] = useState(null);
  const [finalCost, setFinalCost] = useState(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [manualChecking, setManualChecking] = useState(false);
  const [showHelpModal, setShowHelpModal] = useState(false);

  const tickRef = useRef(null);
  const pollRef = useRef(null);

  const fetchStatus = useCallback(async () => {
    if (!orderId) {
      setErrorMessage('Aucun identifiant de commande.');
      setRentalStatus('error');
      return;
    }
    try {
      const { data } = await api.get(`/api/rent/status/${orderId}`);

      if (data.status === 'completed') {
        setRentalStatus('completed');
        setFinalCost(data.finalCost);
        setTimeout(() => navigate(`/rent/summary?orderId=${orderId}`), 800);
        return;
      }
      if (data.status === 'active') {
        setRentalStatus('active');
        if (data.startTime) {
          const ms = new Date(data.startTime).getTime();
          setStartTimeMs(ms);
          const elapsed = Math.floor((Date.now() - ms) / 1000);
          setElapsedSeconds(elapsed > 0 ? elapsed : 0);
        }
      } else if (data.status === 'unknown' || (data.success && !data.status)) {
        setRentalStatus('active');
        setStartTimeMs(Date.now());
        setElapsedSeconds(0);
      } else {
        setErrorMessage(data.message || 'Commande introuvable.');
        setRentalStatus('error');
      }
    } catch (err) {
      setErrorMessage(err.code === 'ECONNABORTED'
        ? 'Le serveur met trop de temps à répondre.'
        : (err.response?.data?.error || err.message));
      setRentalStatus('error');
    }
  }, [orderId, navigate]);

  const handleManualReturnCheck = useCallback(async () => {
    if (manualChecking || rentalStatus !== 'active') return;
    setManualChecking(true);
    try {
      const { data } = await api.get(`/api/rent/status/${orderId}`);
      if (data.status === 'completed') {
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
        if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
        setFinalCost(data.finalCost);
        setRentalStatus('completed');
        setTimeout(() => navigate(`/rent/summary?orderId=${orderId}`), 1200);
      } else {
        alert("En attente de la confirmation de la machine...\n\nLa batterie n'a pas encore été détectée comme retournée. Le système vérifie automatiquement toutes les 3 secondes. Veuillez patienter quelques instants.");
      }
    } catch {
      alert("Impossible de vérifier le statut pour le moment.\n\nLe serveur peut être en cours de démarrage. Le système continue à vérifier automatiquement.");
    } finally {
      setManualChecking(false);
    }
  }, [manualChecking, rentalStatus, orderId, navigate]);

  useEffect(() => {
    fetchStatus();
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [fetchStatus]);

  useEffect(() => {
    if (rentalStatus !== 'active' || !startTimeMs) return;
    tickRef.current = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTimeMs) / 1000);
      setElapsedSeconds(elapsed > 0 ? elapsed : 0);
    }, 1000);
    return () => { if (tickRef.current) clearInterval(tickRef.current); };
  }, [rentalStatus, startTimeMs]);

  useEffect(() => {
    if (rentalStatus !== 'active') return;
    let settled = false;
    pollRef.current = setInterval(async () => {
      if (settled) return;
      try {
        const { data } = await api.get(`/api/rent/status/${orderId}`);
        if (data.status === 'completed') {
          settled = true;
          if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
          if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
          setFinalCost(data.finalCost);
          setRentalStatus('completed');
          setTimeout(() => navigate(`/rent/summary?orderId=${orderId}`), 1200);
          return;
        }
        if (data.startTime && !startTimeMs) {
          const ms = new Date(data.startTime).getTime();
          if (!isNaN(ms)) setStartTimeMs(ms);
        }
      } catch {
        // Keep timer running during Render cold starts
      }
    }, 3000);
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [rentalStatus, orderId, navigate]);

  // ── Derived state ──
  const isInFreePeriod = elapsedSeconds < FREE_SECONDS;
  const freeSecondsLeft = Math.max(0, FREE_SECONDS - elapsedSeconds);
  const freeProgress = Math.min(100, (elapsedSeconds / FREE_SECONDS) * 100);

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  let liveCostEstimate = 0;
  if (elapsedMinutes >= FREE_MINUTES) {
    const billableMinutes = elapsedMinutes - FREE_MINUTES;
    const billableHours = Math.max(1, Math.ceil(billableMinutes / 60));
    liveCostEstimate = Math.min(billableHours * PRICE_PER_HOUR, DAILY_CAP);
  }

  // ── Loading state ──
  if (rentalStatus === 'loading') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 flex items-center justify-center p-6">
        <div className="bg-white p-8 rounded-3xl shadow-xl w-full max-w-md text-center">
          <div className="inline-block w-16 h-16 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin mb-6" />
          <h1 className="text-xl font-bold text-gray-700 mb-2">Chargement de la location...</h1>
          <p className="text-gray-500 text-sm">Récupération des informations de la commande.</p>
        </div>
      </div>
    );
  }

  // ── Error state ──
  if (rentalStatus === 'error') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-red-50 to-orange-50 flex items-center justify-center p-6">
        <div className="bg-white p-8 rounded-3xl shadow-xl w-full max-w-md text-center">
          <div className="text-5xl mb-4">⚠️</div>
          <h1 className="text-xl font-bold text-red-600 mb-2">Erreur</h1>
          <p className="text-gray-600 text-sm mb-6">{errorMessage}</p>
          <button
            onClick={() => navigate('/')}
            className="w-full bg-blue-600 text-white py-3 rounded-xl font-bold hover:bg-blue-700 transition min-h-[48px]"
          >
            Retour à la carte
          </button>
        </div>
      </div>
    );
  }

  // ── Completed state ──
  if (rentalStatus === 'completed') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-emerald-50 to-green-100 flex items-center justify-center p-6">
        <div className="bg-white p-8 rounded-3xl shadow-xl w-full max-w-md text-center">
          <div className="inline-flex items-center justify-center w-20 h-20 bg-emerald-500 rounded-full mb-4 shadow-lg animate-bounce">
            <svg className="w-10 h-10 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-emerald-700 mb-2">✅ Batterie retournée !</h1>
          <p className="text-gray-600 text-sm mb-4">Redirection vers le récapitulatif...</p>
          {finalCost !== null && (
            <div className="bg-emerald-50 rounded-2xl p-4 mb-2">
              <p className="text-emerald-700 text-sm font-bold">
                Montant prélevé : {finalCost.toFixed(2).replace('.', ',')} €
              </p>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Active rental ──
  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-indigo-50 to-emerald-50 flex items-center justify-center p-6 pt-16 pb-12">
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md overflow-hidden">

        {/* ── Header ── */}
        <div className="bg-gradient-to-r from-blue-600 to-indigo-600 px-6 py-5 text-center">
          <div className="inline-flex items-center gap-2 bg-white/15 px-4 py-1.5 rounded-full mb-2 backdrop-blur-sm">
            <div className="w-2.5 h-2.5 bg-emerald-400 rounded-full animate-pulse" />
            <span className="text-white text-xs font-semibold tracking-wide uppercase">Location en cours</span>
          </div>
          <h1 className="text-lg font-bold text-white">Batterie en utilisation</h1>
          {deviceId && (
            <p className="text-blue-200 text-xs mt-0.5">
              Station : <span className="font-mono font-semibold">{deviceId}</span>
            </p>
          )}
        </div>

        <div className="p-6 space-y-5">

          {/* ── Live ticking clock ── */}
          <div className="text-center">
            <p className="text-gray-400 text-xs uppercase tracking-wider mb-2 font-medium">Temps écoulé</p>
            <div className="font-mono text-5xl font-bold text-gray-900 tracking-tight tabular-nums">
              {formatDuration(elapsedSeconds)}
            </div>
          </div>

          {/* ── Free period progress bar / Billing indicator ── */}
          {isInFreePeriod ? (
            <div className="space-y-2">
              {/* Progress bar */}
              <div className="relative h-3 bg-gray-100 rounded-full overflow-hidden">
                <div
                  className="absolute top-0 left-0 h-full bg-gradient-to-r from-emerald-400 to-emerald-500 rounded-full transition-all duration-1000 ease-linear"
                  style={{ width: `${freeProgress}%` }}
                />
              </div>
              {/* Countdown pill */}
              <div className="flex items-center justify-center gap-2">
                <div className="inline-flex items-center gap-2 bg-emerald-50 border border-emerald-200 px-4 py-2 rounded-full">
                  <svg className="w-4 h-4 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <span className="text-emerald-700 text-sm font-bold">
                    Gratuit · {formatCountdown(freeSecondsLeft)}
                  </span>
                </div>
              </div>
              <p className="text-center text-gray-400 text-xs">
                Profitez de votre location gratuite pendant encore {formatCountdown(freeSecondsLeft)}
              </p>
            </div>
          ) : (
            <div className="bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-200 rounded-2xl p-4 text-center">
              <div className="flex items-center justify-center gap-2 mb-1">
                <svg className="w-4 h-4 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1" />
                </svg>
                <span className="text-amber-800 text-sm font-bold">Facturation en cours</span>
              </div>
              <p className="text-amber-700 text-xs">
                Estimation : <span className="font-bold">{liveCostEstimate.toFixed(2).replace('.', ',')} €</span> · {PRICE_PER_HOUR} €/heure
              </p>
            </div>
          )}

          {/* ── Pricing info card ── */}
          <div className="bg-gray-50 rounded-2xl p-4 space-y-2">
            <div className="flex justify-between items-center text-sm">
              <span className="text-gray-500">Tarif</span>
              <span className="text-gray-800 font-semibold">{PRICE_PER_HOUR} € / heure</span>
            </div>
            <div className="flex justify-between items-center text-sm">
              <span className="text-gray-500">Période gratuite</span>
              <span className="text-gray-800 font-semibold">{FREE_MINUTES} min</span>
            </div>
            <div className="flex justify-between items-center text-sm">
              <span className="text-gray-500">Plafond journalier</span>
              <span className="text-gray-800 font-semibold">{DAILY_CAP} €</span>
            </div>
            <div className="flex justify-between items-center text-sm">
              <span className="text-gray-500">Caution (pré-autorisation)</span>
              <span className="text-gray-800 font-semibold">30,00 €</span>
            </div>
          </div>

          {/* ── Return instructions ── */}
          <div className="bg-blue-50 border border-blue-100 rounded-xl p-4">
            <p className="text-blue-800 text-xs font-bold mb-2 uppercase tracking-wide">Comment retourner la batterie</p>
            <ul className="text-blue-700 text-xs space-y-1.5">
              <li className="flex gap-2">
                <span className="font-bold flex-shrink-0">1.</span>
                <span>Recherchez une station de recharge</span>
              </li>
              <li className="flex gap-2">
                <span className="font-bold flex-shrink-0">2.</span>
                <span>Insérez la batterie dans un slot libre</span>
              </li>
              <li className="flex gap-2">
                <span className="font-bold flex-shrink-0">3.</span>
                <span>Le paiement s'effectue automatiquement</span>
              </li>
              <li className="flex gap-2">
                <span className="font-bold flex-shrink-0">4.</span>
                <span>Vous pouvez retourner la batterie à n'importe quelle station</span>
              </li>
            </ul>
          </div>

          {/* ── Manual return button ── */}
          <button
            onClick={handleManualReturnCheck}
            disabled={manualChecking}
            className="w-full bg-emerald-500 text-white py-4 rounded-xl font-bold text-base hover:bg-emerald-600 transition shadow-lg disabled:opacity-60 disabled:cursor-not-allowed min-h-[48px] flex items-center justify-center gap-2"
          >
            {manualChecking ? (
              <>
                <span className="inline-block w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Vérification en cours...
              </>
            ) : (
              <>
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                J'ai retourné la batterie
              </>
            )}
          </button>

          {/* ── Help / Report Issue button ── */}
          <button
            onClick={() => setShowHelpModal(true)}
            className="w-full bg-gray-50 border border-gray-200 text-gray-600 py-3 rounded-xl font-semibold text-sm hover:bg-gray-100 transition min-h-[48px] flex items-center justify-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 5.636l-3.536 3.536m0 5.656l3.536 3.536M9.172 9.172L5.636 5.636m3.536 9.192l-3.536 3.536M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-5-1a1 1 0 100-2 1 1 0 000 2zm-8 0a1 1 0 100-2 1 1 0 000 2z" />
            </svg>
            Signaler un problème
          </button>

          {/* ── Order ID + polling indicator ── */}
          <div className="text-center space-y-1">
            <p className="text-gray-300 text-xs">
              Commande : <span className="font-mono">{orderId}</span>
            </p>
            <p className="text-gray-300 text-xs">
              Vérification automatique toutes les 3 secondes...
            </p>
          </div>

          {/* ── Return to map ── */}
          <button
            onClick={() => navigate('/')}
            className="w-full text-gray-400 hover:text-gray-600 text-sm text-center py-2 transition"
          >
            ← Retour à la carte
          </button>
        </div>
      </div>

      {/* ── Help Modal ── */}
      {showHelpModal && (
        <div
          className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center p-6 z-50"
          onClick={() => setShowHelpModal(false)}
        >
          <div
            className="bg-white rounded-3xl shadow-2xl w-full max-w-sm overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal header */}
            <div className="bg-gradient-to-r from-orange-500 to-red-500 px-6 py-5 text-center">
              <div className="inline-flex items-center justify-center w-12 h-12 bg-white/20 rounded-2xl mb-2 backdrop-blur-sm">
                <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 5.636l-3.536 3.536m0 5.656l3.536 3.536M9.172 9.172L5.636 5.636m3.536 9.192l-3.536 3.536M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-5-1a1 1 0 100-2 1 1 0 000 2zm-8 0a1 1 0 100-2 1 1 0 000 2z" />
                </svg>
              </div>
              <h2 className="text-lg font-bold text-white">Signaler un problème</h2>
            </div>

            <div className="p-6 space-y-4">
              {/* Battery defective */}
              <div className="bg-orange-50 border border-orange-200 rounded-xl p-4">
                <p className="text-sm font-bold text-orange-800 mb-1">🔋 Batterie défectueuse ?</p>
                <p className="text-xs text-orange-700 leading-relaxed">
                  Si la batterie ne charge pas votre téléphone, remettez-la simplement dans la station. La location sera annulée gratuitement si vous la retournez dans les 5 premières minutes.
                </p>
              </div>

              {/* Can't return */}
              <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
                <p className="text-sm font-bold text-blue-800 mb-1">📍 Impossible de retourner ?</p>
                <p className="text-xs text-blue-700 leading-relaxed">
                  Assurez-vous d'insérer fermement la batterie dans un slot libre jusqu'au clic. Vous pouvez la retourner à n'importe quelle station de notre réseau.
                </p>
              </div>

              {/* Contact */}
              <div className="bg-gray-50 rounded-xl p-4 text-center">
                <p className="text-xs text-gray-500 mb-2">Besoin d'aide supplémentaire ?</p>
                <a
                  href="tel:+33000000000"
                  className="inline-flex items-center gap-2 text-blue-600 font-bold text-sm hover:text-blue-700 transition"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.288a11.043 11.043 0 005.516 5.516l1.288-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.948V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                  </svg>
                  Contacter le support
                </a>
              </div>

              <button
                onClick={() => setShowHelpModal(false)}
                className="w-full bg-gray-100 text-gray-600 py-3 rounded-xl font-bold text-sm hover:bg-gray-200 transition min-h-[48px]"
              >
                Fermer
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
