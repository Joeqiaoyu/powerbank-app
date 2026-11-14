import { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import axios from 'axios';

const API_BASE = import.meta.env.VITE_API_URL || 'https://powerbank-app-im73.onrender.com';
const api = axios.create({ baseURL: API_BASE, timeout: 60000 });

export default function RentSuccess() {
  const [searchParams] = useSearchParams();
  const deviceId = searchParams.get('deviceId');
  const navigate = useNavigate();

  const [stage, setStage] = useState('ejecting'); // ejecting → redirecting → error
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!deviceId) {
      setStage('error');
      setMessage('Erreur: aucun identifiant de station.');
      return;
    }

    const ejectBattery = async () => {
      setStage('ejecting');
      setMessage('Deverrouillage de la batterie en cours...');

      try {
        const res = await api.post('/api/rent/eject', { deviceId });

        if (res.data.success && res.data.tradeNo) {
          const orderId = res.data.tradeNo;
          setMessage('Batterie ejectee ! Redirection...');
          setStage('redirecting');

          // Redirect to the active rental page with the live timer
          setTimeout(() => {
            navigate(`/rent/active?orderId=${orderId}&deviceId=${deviceId}`);
          }, 1000);
        } else {
          setStage('error');
          setMessage(res.data.message || 'Echec du deverrouillage.');
        }
      } catch (err) {
        const errMsg = err.code === 'ECONNABORTED'
          ? 'Le serveur met trop de temps a repondre.'
          : (err.response?.data?.message || err.response?.data?.error || err.message);
        setStage('error');
        setMessage('Echec: ' + errMsg);
      }
    };

    ejectBattery();
  }, [deviceId, navigate]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-green-50 flex items-center justify-center p-6 pt-16">
      <div className="bg-white p-8 rounded-3xl shadow-xl w-full max-w-md text-center">

        {/* ── Ejecting spinner ── */}
        {stage === 'ejecting' && (
          <>
            <div className="inline-block w-16 h-16 border-4 border-blue-200 border-t-blue-500 rounded-full animate-spin mb-6" />
            <h1 className="text-2xl font-bold text-blue-600 mb-2">Deverrouillage...</h1>
            <p className="text-gray-500 text-sm">{message}</p>
            <p className="text-gray-400 text-xs mt-4">
              Station: <span className="font-mono font-semibold">{deviceId}</span>
            </p>
          </>
        )}

        {/* ── Redirecting ── */}
        {stage === 'redirecting' && (
          <>
            <div className="inline-flex items-center justify-center w-16 h-16 bg-green-500 rounded-full mb-6 shadow-lg">
              <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={3}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h1 className="text-2xl font-bold text-green-600 mb-2">Batterie ejectee !</h1>
            <p className="text-gray-500 text-sm">{message}</p>
          </>
        )}

        {/* ── Error ── */}
        {stage === 'error' && (
          <>
            <div className="text-5xl mb-4">⚠️</div>
            <h1 className="text-xl font-bold text-red-600 mb-2">Erreur</h1>
            <p className="text-gray-600 text-sm mb-6">{message}</p>
            <button
              onClick={() => navigate(`/rent?deviceId=${deviceId}`)}
              className="w-full bg-blue-500 text-white py-3 rounded-xl font-bold hover:bg-blue-600 transition mb-3"
            >
              Reessayer
            </button>
          </>
        )}

        {/* ── Return to map ── */}
        {stage !== 'redirecting' && (
          <button
            onClick={() => navigate('/')}
            className="mt-4 text-gray-400 underline text-sm w-full text-center"
          >
            Retour a la carte
          </button>
        )}
      </div>
    </div>
  );
}
