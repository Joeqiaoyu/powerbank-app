import { useState, useEffect, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import axios from 'axios';

const API_BASE = import.meta.env.VITE_API_URL || 'https://powerbank-app-im73.onrender.com';
const api = axios.create({ baseURL: API_BASE, timeout: 60000 });

export default function RentSuccess() {
  const [searchParams] = useSearchParams();
  const deviceId = searchParams.get('deviceId');
  const navigate = useNavigate();

  const [stage, setStage] = useState('idle'); // idle -> ejecting -> active -> completed -> error
  const [message, setMessage] = useState('');
  const [tradeNo, setTradeNo] = useState(null);
  const pollRef = useRef(null);

  // ── On mount: immediately trigger battery eject ──
  useEffect(() => {
    if (!deviceId) {
      setMessage('Erreur: aucun identifiant de station.');
      setStage('error');
      return;
    }

    const ejectBattery = async () => {
      setStage('ejecting');
      setMessage('Dverrouillage en cours...');

      try {
        const res = await api.post('/api/rent/eject', { deviceId });

        if (res.data.success && res.data.tradeNo) {
          const tn = res.data.tradeNo;
          setTradeNo(tn);
          setMessage('Batterie jecte ! Vous pouvez la retirer.');
          setStage('active');
          // Start polling for return / completion
          pollReturnStatus(tn);
        } else {
          setMessage('' + (res.data.message || 'chec du dverrouillage.'));
          setStage('error');
        }
      } catch (err) {
        const errMsg = err.code === 'ECONNABORTED'
          ? 'Le serveur met trop de temps  rpondre.'
          : (err.response?.data?.message || err.response?.data?.error || err.message);
        setMessage(' chec: ' + errMsg);
        setStage('error');
      }
    };

    ejectBattery();

    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [deviceId]);

  // ── Poll for battery return / rental completion ──
  // Uses GET /api/rent/status/:orderId every 7 seconds
  // Once status === 'completed', redirect to /rent/summary
  const pollReturnStatus = (tn) => {
    let attempts = 0;
    const maxAttempts = 120; // 120 × 7s = 14 minutes max rental wait

    pollRef.current = setInterval(async () => {
      attempts++;
      try {
        const { data } = await api.get(`/api/rent/status/${tn}`);

        if (data.status === 'completed') {
          clearInterval(pollRef.current);
          pollRef.current = null;
          setMessage('Batterie retourne ! Redirection vers le rcapitulatif...');
          setStage('completed');

          // Redirect to summary page after 1.5s
          setTimeout(() => {
            navigate(`/rent/summary?orderId=${tn}`);
          }, 1500);
        } else if (data.status === 'active') {
          // Rental still active — battery not yet returned
          setMessage(`Location en cours. Retournez la batterie quand vous avez fini. (${Math.floor(attempts * 7 / 60)} min)`);
        } else if (attempts >= maxAttempts) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          setMessage('Dlai dpass (14 min). La location est peut-tre toujours active.');
          setStage('error');
        }
      } catch (err) {
        // Keep polling on transient errors
        console.warn('[POLL] Status query error:', err.message);
        if (attempts >= maxAttempts) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          setMessage('Erreur de vrification du statut.');
          setStage('error');
        }
      }
    }, 7000); // Poll every 7 seconds
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-green-50 flex items-center justify-center p-6 pt-16">
      <div className="bg-white p-8 rounded-3xl shadow-xl w-full max-w-md text-center">
        {/* ── Stage: ejecting ── */}
        {stage === 'ejecting' && (
          <div className="mb-6">
            <div className="inline-block w-16 h-16 border-4 border-blue-200 border-t-blue-500 rounded-full animate-spin" />
          </div>
        )}

        {/* ── Stage: active (battery ejected, waiting for return) ── */}
        {stage === 'active' && (
          <div className="mb-6">
            <div className="text-6xl mb-2"></div>
            <div className="inline-flex items-center gap-2 bg-green-100 px-4 py-2 rounded-full">
              <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
              <span className="text-green-700 text-sm font-medium">Location en cours</span>
            </div>
          </div>
        )}

        {/* ── Stage: completed (redirecting) ── */}
        {stage === 'completed' && (
          <div className="mb-6">
            <div className="inline-flex items-center justify-center w-16 h-16 bg-green-500 rounded-full mb-2">
              <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={3}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
          </div>
        )}

        {/* ── Stage: error ── */}
        {stage === 'error' && (
          <div className="mb-6 text-6xl"></div>
        )}

        {/* ── Title ── */}
        <h1 className={`text-2xl font-bold mb-4 ${
          stage === 'completed' ? 'text-green-600' :
          stage === 'error' ? 'text-red-600' :
          stage === 'active' ? 'text-green-700' :
          'text-blue-600'
        }`}>
          {stage === 'completed' ? 'Retour dtect !' :
           stage === 'error' ? 'Erreur' :
           stage === 'active' ? 'Batterie en location' :
           'Paiement Russi'}
        </h1>

        {/* ── Device info ── */}
        <p className="text-gray-600 mb-2 text-sm">
          Station: <span className="font-mono font-semibold">{deviceId}</span>
        </p>

        {tradeNo && (
          <p className="text-gray-400 mb-2 text-xs">
            Commande: <span className="font-mono">{tradeNo}</span>
          </p>
        )}

        {/* ── Status message ── */}
        <div className={`mt-4 p-4 rounded-xl text-sm ${
          message.includes('') ? 'bg-red-50 text-red-700' :
          message.includes('') || stage === 'completed' ? 'bg-green-50 text-green-700' :
          stage === 'active' ? 'bg-blue-50 text-blue-700' :
          'bg-gray-50 text-gray-700'
        }`}>
          {message}
        </div>

        {/* ── Active rental instructions ── */}
        {stage === 'active' && (
          <div className="mt-4 bg-amber-50 border border-amber-200 rounded-xl p-4 text-left">
            <p className="text-amber-800 text-xs font-semibold mb-2">Instructions :</p>
            <ul className="text-amber-700 text-xs space-y-1 list-disc list-inside">
              <li>Utilisez votre batterie en toute srnit</li>
              <li>Premires 10 minutes gratuites</li>
              <li>1/heure ensuite (plafond 30/jour)</li>
              <li>Remettez la batterie dans n'importe quel slot de la station pour terminer</li>
            </ul>
          </div>
        )}

        {/* ── Error retry ── */}
        {stage === 'error' && (
          <button
            onClick={() => navigate(`/rent?deviceId=${deviceId}`)}
            className="mt-6 w-full bg-blue-500 text-white py-3 rounded-xl font-bold hover:bg-blue-600 transition"
          >
            Ressayer
          </button>
        )}

        {/* ── Return to map ── */}
        {stage !== 'completed' && (
          <button
            onClick={() => navigate('/')}
            className="mt-4 text-gray-400 underline text-sm w-full text-center"
          >
            Retour  la carte
          </button>
        )}
      </div>
    </div>
  );
}
