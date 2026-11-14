import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { QRCodeCanvas } from 'qrcode.react';
import axios from 'axios';

const API_BASE = import.meta.env.VITE_API_URL || 'https://powerbank-app-im73.onrender.com';
const api = axios.create({ baseURL: API_BASE, timeout: 30000 });

export default function AdminQRCodes() {
  const navigate = useNavigate();

  const [stations, setStations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchStations = async () => {
      try {
        const { data } = await api.get('/api/nearby');

        // /api/nearby returns an array of station objects
        const list = Array.isArray(data) ? data : (data.stations || []);

        // Sort by device ID for consistent display
        list.sort((a, b) => (a.id || '').localeCompare(b.id || ''));
        setStations(list);
        setLoading(false);
      } catch (err) {
        console.error('[ADMIN QR] Failed to fetch stations:', err.message);
        setError(err.response?.data?.error || err.message);
        setLoading(false);
      }
    };

    fetchStations();
  }, []);

  // ── Print handler ──
  const handlePrint = () => {
    window.print();
  };

  // ── Download single QR code as PNG ──
  const downloadQR = (stationId, canvasRef) => {
    const canvas = canvasRef?.current;
    if (!canvas) return;

    const pngUrl = canvas
      .toDataURL('image/png')
      .replace('image/png', 'image/octet-stream');

    const link = document.createElement('a');
    link.href = pngUrl;
    link.download = `QR-${stationId}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // ── Loading state ──
  if (loading) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center p-6">
        <div className="bg-white p-8 rounded-3xl shadow-xl w-full max-w-md text-center">
          <div className="inline-block w-16 h-16 border-4 border-blue-200 border-t-blue-500 rounded-full animate-spin mb-6" />
          <h1 className="text-xl font-bold text-gray-700 mb-2">Chargement des stations...</h1>
          <p className="text-gray-500 text-sm">Récupération de la flotte depuis le backend.</p>
        </div>
      </div>
    );
  }

  // ── Error state ──
  if (error) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center p-6">
        <div className="bg-white p-8 rounded-3xl shadow-xl w-full max-w-md text-center">
          <div className="text-5xl mb-4">⚠️</div>
          <h1 className="text-xl font-bold text-red-600 mb-2">Erreur</h1>
          <p className="text-gray-600 text-sm mb-6">{error}</p>
          <button
            onClick={() => window.location.reload()}
            className="w-full bg-blue-500 text-white py-3 rounded-xl font-bold hover:bg-blue-600 transition mb-3"
          >
            Réessayer
          </button>
          <button
            onClick={() => navigate('/')}
            className="w-full bg-gray-100 text-gray-600 py-3 rounded-xl font-bold text-sm hover:bg-gray-200 transition"
          >
            Retour à la carte
          </button>
        </div>
      </div>
    );
  }

  // ── Empty state ──
  if (stations.length === 0) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center p-6">
        <div className="bg-white p-8 rounded-3xl shadow-xl w-full max-w-md text-center">
          <div className="text-5xl mb-4">📭</div>
          <h1 className="text-xl font-bold text-gray-700 mb-2">Aucune station trouvée</h1>
          <p className="text-gray-500 text-sm mb-6">
            Le backend n'a retourné aucune station active.
          </p>
          <button
            onClick={() => navigate('/')}
            className="w-full bg-blue-500 text-white py-3 rounded-xl font-bold hover:bg-blue-600 transition"
          >
            Retour à la carte
          </button>
        </div>
      </div>
    );
  }

  const onlineCount = stations.filter(s => s.isOnline !== false).length;

  return (
    <div className="min-h-screen bg-gray-100">
      {/* ── Header (hidden on print) ── */}
      <div className="no-print bg-white border-b border-gray-200 sticky top-0 z-10 shadow-sm">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">QR Codes Administrateur</h1>
            <p className="text-gray-500 text-sm mt-1">
              {stations.length} station(s) · {onlineCount} en ligne ·{' '}
              <span className="font-mono text-gray-400">/admin/qrcodes</span>
            </p>
          </div>
          <div className="flex gap-3">
            <button
              onClick={handlePrint}
              className="bg-blue-500 text-white px-6 py-3 rounded-xl font-bold hover:bg-blue-600 transition shadow-lg flex items-center gap-2"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
              </svg>
              Imprimer
            </button>
            <button
              onClick={() => navigate('/')}
              className="bg-gray-100 text-gray-600 px-6 py-3 rounded-xl font-bold hover:bg-gray-200 transition"
            >
              Retour
            </button>
          </div>
        </div>
      </div>

      {/* ── QR Code Grid ── */}
      <div className="max-w-6xl mx-auto px-6 py-8">
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">

          {stations.map((station) => {
            const rentalUrl = `${window.location.origin}/rent?deviceId=${station.id}`;

            return (
              <QRCard
                key={station.id}
                station={station}
                rentalUrl={rentalUrl}
                onDownload={downloadQR}
              />
            );
          })}
        </div>

        {/* ── Print-only footer ── */}
        <div className="print-only mt-12 text-center text-gray-400 text-xs">
          <p>Généré le {new Date().toLocaleDateString('fr-FR')} · PowerBank H5 Admin</p>
        </div>
      </div>

      {/* ── Inline print styles ── */}
      <style>{`
        @media print {
          .no-print { display: none !important; }
          .print-only { display: block !important; }
          body { background: white !important; }
          .qr-card {
            break-inside: avoid;
            page-break-inside: avoid;
            box-shadow: none !important;
            border: 2px solid #000 !important;
          }
        }
        @media screen {
          .print-only { display: none; }
        }
      `}</style>
    </div>
  );
}

// ── QR Card sub-component ──
function QRCard({ station, rentalUrl, onDownload }) {
  // Use a ref to the canvas for PNG download
  const canvasRef = useState(null);
  const refCallback = (node) => {
    if (node) {
      // qrcode.react renders a <canvas> inside the component
      // We store it on the ref for download
      canvasRef[0] = node.querySelector('canvas') || node;
    }
  };

  const isOnline = station.isOnline !== false;
  const batteryCount = station.rentableBatteries ?? station.batteries ?? station.availablePowerBanks ?? 0;

  return (
    <div className="qr-card bg-white rounded-2xl shadow-lg border border-gray-200 p-6 flex flex-col items-center">
      {/* ── Status badge (screen only) ── */}
      <div className="no-print mb-3">
        <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold ${
          isOnline ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
        }`}>
          <span className={`w-2 h-2 rounded-full ${isOnline ? 'bg-green-500' : 'bg-gray-400'}`} />
          {isOnline ? 'En ligne' : 'Hors ligne'}
        </span>
      </div>

      {/* ── QR Code ── */}
      <div ref={refCallback} className="mb-4">
        <QRCodeCanvas
          value={rentalUrl}
          size={200}
          level="M"
          marginSize={2}
          fgColor="#000000"
          bgColor="#ffffff"
        />
      </div>

      {/* ── Device ID (bold, below QR) ── */}
      <div className="text-center mb-2">
        <p className="text-gray-400 text-xs uppercase tracking-wider font-medium">Station</p>
        <p className="text-gray-900 text-xl font-bold font-mono tracking-wide">{station.id}</p>
      </div>

      {/* ── Shop name (if available) ── */}
      {station.shopName && (
        <p className="text-gray-500 text-xs text-center mb-2 max-w-[200px] truncate">
          {station.shopName}
        </p>
      )}

      {/* ── Battery count (if available) ── */}
      {batteryCount > 0 && (
        <p className="text-gray-400 text-xs text-center mb-3">
          {batteryCount} batterie(s) disponible(s)
        </p>
      )}

      {/* ── URL (small, for reference) ── */}
      <p className="text-gray-300 text-[10px] text-center break-all max-w-[200px] mb-3 font-mono">
        {rentalUrl}
      </p>

      {/* ── Download button (screen only) ── */}
      <button
        onClick={() => onDownload(station.id, { current: canvasRef[0] })}
        className="no-print w-full bg-gray-100 text-gray-600 py-2 rounded-lg font-bold text-xs hover:bg-gray-200 transition flex items-center justify-center gap-2"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
        </svg>
        Télécharger PNG
      </button>
    </div>
  );
}
