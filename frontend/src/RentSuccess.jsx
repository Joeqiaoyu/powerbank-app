import { useState, useEffect, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import axios from 'axios';

// ── Production-safe env var ──
const API_BASE = import.meta.env.VITE_API_URL || 'https://powerbank-app-im73.onrender.com';
const api = axios.create({ baseURL: API_BASE, timeout: 60000 });

export default function RentSuccess() {
  const [searchParams] = useSearchParams();
  const deviceId = searchParams.get('deviceId');
  const navigate = useNavigate();

  const [stage, setStage] = useState('idle'); // idle -> ejecting -> success -> error
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
      setMessage('Déverrouillage en cours...');

      try {
        const res = await api.post('/api/rent/eject', { deviceId });

        if (res.data.success && res.data.tradeNo) {
          setTradeNo(res.data.tradeNo);
          setMessage('⏳ Déverrouillage en cours...');
          pollStatus(res.data.tradeNo);
        } else {
          setMessage('❌ ' + (res.data.message || 'Échec du déverrouillage.'));
          setStage('error');
        }
      } catch (err) {
        const errMsg = err.code === 'ECONNABORTED'
          ? 'Le serveur met trop de temps à répondre.'
          : (err.response?.data?.message || err.response?.data?.error || err.message);
        setMessage('❌ Échec: ' + errMsg);
        setStage('error');
      }
    };

    ejectBattery();

    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [deviceId]);

  // ── Poll rental order status ──
  const pollStatus = (tn) => {
    let attempts = 0;
    const maxAttempts = 30;

    pollRef.current = setInterval(async () => {
      attempts++;
      try {
        const { data } = await api.post('/api/rent/status', { tradeNo: tn });

        if (data.success) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          setMessage('✅ Batterie éjectée avec succès ! Retirez-la maintenant.');
          setStage('success');
        } else if (attempts >= maxAttempts) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          setMessage('❌ Délai dépassé. Contactez le support.');
          setStage('error');
        } else {
          setMessage(`⏳ Déverrouillage en cours... (${attempts}/${maxAttempts})`);
        }
      } catch (err) {
        if (attempts >= maxAttempts) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          setMessage('❌ Erreur de vérification du statut.');
          setStage('error');
        }
      }
    }, 2000);
  };

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
      <div className="bg-white p-8 rounded-2xl shadow-xl w-full max-w-md text-center">
        {stage === 'ejecting' && (
          <div className="mb-6">
            <div className="inline-block w-16 h-16 border-4 border-blue-200 border-t-blue-500 rounded-full animate-spin" />
          </div>
        )}
        {stage === 'success' && (
          <div className="mb-6 text-6xl">🔋✅</div>
        )}
        {stage === 'error' && (
          <div className="mb-6 text-6xl">⚠️</div>
        )}

        <h1 className={`text-2xl font-bold mb-4 ${
          stage === 'success' ? 'text-green-600' :
          stage === 'error' ? 'text-red-600' :
          'text-blue-600'
        }`}>
          {stage === 'success' ? 'Succès !' :
           stage === 'error' ? 'Erreur' :
           'Paiement Reussi'}
        </h1>

        <p className="text-gray-600 mb-2 text-sm">
          Station: <span className="font-mono font-semibold">{deviceId}</span>
        </p>

        <div className={`mt-4 p-4 rounded-xl text-sm ${
          message.includes('❌') ? 'bg-red-50 text-red-700' :
          message.includes('✅') ? 'bg-green-50 text-green-700' :
          'bg-blue-50 text-blue-700'
        }`}>
          {message}
        </div>

        {stage === 'error' && (
          <button
            onClick={() => navigate(`/rent?deviceId=${deviceId}`)}
            className="mt-6 w-full bg-blue-500 text-white py-3 rounded-xl font-bold"
          >
            Réessayer
          </button>
        )}

        <button
          onClick={() => navigate('/')}
          className="mt-4 text-gray-400 underline text-sm w-full text-center"
        >
          Retour à la carte
        </button>
      </div>
    </div>
  );
}
