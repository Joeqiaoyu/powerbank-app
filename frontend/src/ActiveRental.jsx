import { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import axios from 'axios';

const API_BASE = import.meta.env.VITE_API_URL || 'https://powerbank-app-im73.onrender.com';
const api = axios.create({ baseURL: API_BASE, timeout: 30000 });

// ── Format seconds as HH:MM:SS ──
function formatDuration(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ── Pricing constants (must match backend) ──
const PRICE_PER_HOUR = 1;
const FREE_MINUTES = 10;
const DAILY_CAP = 30;

export default function ActiveRental() {
  const [searchParams] = useSearchParams();
  const orderId = searchParams.get('orderId');
  const deviceId = searchParams.get('deviceId');
  const navigate = useNavigate();

  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [rentalStatus, setRentalStatus] = useState('loading'); // loading → active → completed → error
  const [startTimeMs, setStartTimeMs] = useState(null);
  const [finalCost, setFinalCost] = useState(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [pollCount, setPollCount] = useState(0);

  const tickRef = useRef(null);
  const pollRef = useRef(null);

  // ── Fetch initial rental status to get startTime ──
  const fetchStatus = useCallback(async () => {
    if (!orderId) {
      setErrorMessage('Aucun identifiant de commande.');
      setRentalStatus('error');
      return;
    }

    try {
      const { data } = await api.get(`/api/rent/status/${orderId}`);

      // ── Log initial status fetch for debugging ──
      console.log("[INITIAL STATUS FETCH]", {
        status: data.status,
        orderId: data.orderId,
        startTime: data.startTime,
        totalDuration: data.totalDuration,
        finalCost: data.finalCost,
        hasBilling: !!data.billing,
        raw: data,
      });

      if (data.status === 'completed') {
        // Battery already returned — go straight to summary
        setRentalStatus('completed');
        setFinalCost(data.finalCost);
        setTimeout(() => navigate(`/rent/summary?orderId=${orderId}`), 800);
        return;
      }

      if (data.status === 'active' || data.success) {
        setRentalStatus('active');

        // Parse startTime from backend ISO string
        if (data.startTime) {
          const ms = new Date(data.startTime).getTime();
          setStartTimeMs(ms);
          // Immediately calculate elapsed
          const elapsed = Math.floor((Date.now() - ms) / 1000);
          setElapsedSeconds(elapsed > 0 ? elapsed : 0);
        }
      } else {
        setErrorMessage(data.message || 'Commande introuvable.');
        setRentalStatus('error');
      }
    } catch (err) {
      const errMsg = err.code === 'ECONNABORTED'
        ? 'Le serveur met trop de temps a repondre.'
        : (err.response?.data?.error || err.message);
      setErrorMessage(errMsg);
      setRentalStatus('error');
    }
  }, [orderId, navigate]);

  useEffect(() => {
    fetchStatus();
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [fetchStatus]);

  // ── Live ticking clock: updates every second ──
  useEffect(() => {
    if (rentalStatus !== 'active' || !startTimeMs) return;

    tickRef.current = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTimeMs) / 1000);
      setElapsedSeconds(elapsed > 0 ? elapsed : 0);
    }, 1000);

    return () => { if (tickRef.current) clearInterval(tickRef.current); };
  }, [rentalStatus, startTimeMs]);

  // ── Backend polling: check for battery return every 5 seconds ──
  // CRITICAL: This interval MUST clear itself the instant status='completed' is detected.
  // Both the polling interval AND the 1-second tick clock must stop immediately.
  useEffect(() => {
    if (rentalStatus !== 'active') return;

    // Use a local flag to prevent race conditions between interval fires
    let settled = false;

    pollRef.current = setInterval(async () => {
      // Guard: if already settled by a previous interval fire, skip
      if (settled) return;

      setPollCount(prev => prev + 1);

      try {
        const { data } = await api.get(`/api/rent/status/${orderId}`);

        // ── POLLING FAILSAFE: log every response for debugging ──
        console.log("[POLL RESPONSE]", {
          pollNumber: pollCount + 1,
          status: data.status,
          orderId: data.orderId,
          totalDuration: data.totalDuration,
          finalCost: data.finalCost,
          hasBilling: !!data.billing,
          raw: data,
        });

        // ── STRICT CHECK: status must be exactly 'completed' ──
        if (data.status === 'completed') {
          settled = true; // Prevent any further processing

          // ── CRITICAL: Clear BOTH intervals IMMEDIATELY ──
          // The tick clock (1s) and the polling interval (5s) must stop
          // the instant we detect completion.
          if (pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
          }
          if (tickRef.current) {
            clearInterval(tickRef.current);
            tickRef.current = null;
          }

          setFinalCost(data.finalCost);
          setRentalStatus('completed');

          // Auto-redirect to summary after brief delay so user sees the "returned" flash
          setTimeout(() => {
            navigate(`/rent/summary?orderId=${orderId}`);
          }, 1200);
          return;
        }

        // ── Sync startTime from backend if we don't have it yet ──
        // (handles case where initial fetch failed to parse it)
        if (data.startTime && !startTimeMs) {
          const ms = new Date(data.startTime).getTime();
          if (!isNaN(ms)) {
            setStartTimeMs(ms);
          }
        }
      } catch (err) {
        console.warn('[POLL] Status query error:', err.message);
        console.warn('[POLL] Error details:', {
          code: err.code,
          status: err.response?.status,
          data: err.response?.data,
        });
        // Do NOT change rentalStatus on poll error — keep timer running.
        // The backend may be cold-starting (Render free tier). Next poll may succeed.
      }
    }, 5000);

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [rentalStatus, orderId, navigate]); // Note: startTimeMs intentionally excluded — synced inside interval

  // ── Calculate live cost estimate ──
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  let liveCostEstimate = 0;
  if (elapsedMinutes > FREE_MINUTES) {
    const billableMinutes = elapsedMinutes - FREE_MINUTES;
    const billableHours = Math.ceil(billableMinutes / 60);
    liveCostEstimate = Math.min(billableHours * PRICE_PER_HOUR, DAILY_CAP);
  }

  const isInFreePeriod = elapsedMinutes <= FREE_MINUTES;
  const freeMinutesLeft = Math.max(0, FREE_MINUTES - elapsedMinutes);
  const freeSecondsLeft = Math.max(0, FREE_MINUTES * 60 - elapsedSeconds);

  // ── Loading state ──
  if (rentalStatus === 'loading') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-green-50 flex items-center justify-center p-6">
        <div className="bg-white p-8 rounded-3xl shadow-xl w-full max-w-md text-center">
          <div className="inline-block w-16 h-16 border-4 border-blue-200 border-t-blue-500 rounded-full animate-spin mb-6" />
          <h1 className="text-xl font-bold text-gray-700 mb-2">Chargement de la location...</h1>
          <p className="text-gray-500 text-sm">Recuperation des informations de la commande.</p>
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
            className="w-full bg-blue-500 text-white py-3 rounded-xl font-bold hover:bg-blue-600 transition"
          >
            Retour a la carte
          </button>
        </div>
      </div>
    );
  }

  // ── Completed state (brief flash before redirect) ──
  if (rentalStatus === 'completed') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-green-50 to-emerald-100 flex items-center justify-center p-6">
        <div className="bg-white p-8 rounded-3xl shadow-xl w-full max-w-md text-center">
          <div className="inline-flex items-center justify-center w-20 h-20 bg-green-500 rounded-full mb-4 shadow-lg animate-bounce">
            <svg className="w-10 h-10 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-green-700 mb-2">Batterie retournee !</h1>
          <p className="text-gray-500 text-sm">Redirection vers le recapitulatif...</p>
        </div>
      </div>
    );
  }

  // ── Active rental: live ticking clock ──
  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-indigo-50 to-green-50 flex items-center justify-center p-6 pt-16">
      <div className="bg-white p-8 rounded-3xl shadow-2xl w-full max-w-md">

        {/* ── Header with pulsing indicator ── */}
        <div className="text-center mb-6">
          <div className="inline-flex items-center gap-2 bg-green-100 px-4 py-2 rounded-full mb-4">
            <div className="w-3 h-3 bg-green-500 rounded-full animate-pulse" />
            <span className="text-green-700 text-sm font-semibold tracking-wide">LOCATION EN COURS</span>
          </div>
          <h1 className="text-xl font-bold text-gray-800">Batterie en utilisation</h1>
          {deviceId && (
            <p className="text-gray-400 text-xs mt-1">
              Station: <span className="font-mono font-semibold">{deviceId}</span>
            </p>
          )}
        </div>

        {/* ── Live ticking clock ── */}
        <div className="text-center mb-6">
          <p className="text-gray-500 text-xs uppercase tracking-wider mb-2 font-medium">Temps ecoule</p>
          <div className="font-mono text-5xl font-bold text-gray-900 tracking-tight tabular-nums">
            {formatDuration(elapsedSeconds)}
          </div>
        </div>

        {/* ── Free period banner ── */}
        {isInFreePeriod ? (
          <div className="bg-green-50 border-2 border-green-200 rounded-2xl p-4 mb-4 text-center">
            <p className="text-green-700 text-sm font-bold">
              ✓ Periode gratuite
            </p>
            <p className="text-green-600 text-xs mt-1">
              Plus que {Math.floor(freeSecondsLeft / 60)} min {freeSecondsLeft % 60} s gratuite(s)
            </p>
          </div>
        ) : (
          <div className="bg-amber-50 border-2 border-amber-200 rounded-2xl p-4 mb-4 text-center">
            <p className="text-amber-800 text-sm font-bold">
              Facturation en cours
            </p>
            <p className="text-amber-700 text-xs mt-1">
              Estimation: {liveCostEstimate.toFixed(2).replace('.', ',')} € · {PRICE_PER_HOUR} €/heure
            </p>
          </div>
        )}

        {/* ── Pricing info card ── */}
        <div className="bg-gray-50 rounded-2xl p-4 mb-6 space-y-2">
          <div className="flex justify-between items-center text-sm">
            <span className="text-gray-500">Tarif</span>
            <span className="text-gray-800 font-semibold">{PRICE_PER_HOUR} € / heure</span>
          </div>
          <div className="flex justify-between items-center text-sm">
            <span className="text-gray-500">Periode gratuite</span>
            <span className="text-gray-800 font-semibold">{FREE_MINUTES} min</span>
          </div>
          <div className="flex justify-between items-center text-sm">
            <span className="text-gray-500">Plafond journalier</span>
            <span className="text-gray-800 font-semibold">{DAILY_CAP} €</span>
          </div>
          <div className="flex justify-between items-center text-sm">
            <span className="text-gray-500">Caution (pre-autorisation)</span>
            <span className="text-gray-800 font-semibold">30,00 €</span>
          </div>
        </div>

        {/* ── Instructions ── */}
        <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 mb-6">
          <p className="text-blue-800 text-xs font-bold mb-2 uppercase tracking-wide">Comment retourner la batterie</p>
          <ul className="text-blue-700 text-xs space-y-1.5">
            <li className="flex gap-2">
              <span className="font-bold">1.</span>
              <span>Recherchez une station de recharge</span>
            </li>
            <li className="flex gap-2">
              <span className="font-bold">2.</span>
              <span>Inserez la batterie dans un slot libre</span>
            </li>
            <li className="flex gap-2">
              <span className="font-bold">3.</span>
              <span>Le paiement s'effectue automatiquement</span>
            </li>
            <li className="flex gap-2">
              <span className="font-bold">4.</span>
              <span>Vous pouvez retourner la batterie a n'importe quelle station</span>
            </li>
          </ul>
        </div>

        {/* ── Order ID ── */}
        <p className="text-gray-400 text-xs text-center mb-4">
          Commande: <span className="font-mono">{orderId}</span>
        </p>

        {/* ── Polling indicator (subtle) ── */}
        <p className="text-gray-300 text-xs text-center mb-4">
          Verification automatique toutes les 5 secondes...
        </p>

        {/* ── Return to map button ── */}
        <button
          onClick={() => navigate('/')}
          className="w-full bg-gray-100 text-gray-600 py-3 rounded-xl font-bold text-sm hover:bg-gray-200 transition"
        >
          Retour a la carte
        </button>
      </div>
    </div>
  );
}
