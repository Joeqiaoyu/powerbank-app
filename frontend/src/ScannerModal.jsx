import { useEffect, useRef, useState } from 'react';
import { Html5Qrcode } from 'html5-qrcode';

/**
 * Modal de scan QR — ouvre la caméra et lit le QR code de la station.
 * Repli : saisie manuelle du numéro de la machine.
 */
export default function ScannerModal({ onScan, onClose }) {
  const [manualId, setManualId] = useState('');
  const [camError, setCamError] = useState(false);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const qr = new Html5Qrcode('qr-reader', { verbose: false });
    let stopped = false;

    qr.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 250, height: 250 } },
      (decodedText) => {
        if (stopped) return;
        stopped = true;
        qr.stop().catch(() => {}).finally(() => onScan(decodedText));
      },
      () => { /* frame sans QR : on ignore */ }
    ).catch(() => setCamError(true));

    return () => {
      stopped = true;
      qr.stop().catch(() => {});
      try { qr.clear(); } catch { /* ignore */ }
    };
  }, [onScan]);

  const submitManual = () => {
    const id = manualId.trim();
    if (id) onScan(id);
  };

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 40,
        backgroundColor: 'rgba(0,0,0,0.85)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        padding: '20px',
      }}
      onClick={onClose}
    >
      <div
        style={{ backgroundColor: 'white', borderRadius: '16px', padding: '20px', width: '100%', maxWidth: '420px' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 style={{ margin: '0 0 12px', fontSize: '18px', fontWeight: 'bold', color: 'black', textAlign: 'center' }}>
          📷 Scanner le QR code
        </h2>

        {!camError ? (
          <div id="qr-reader" style={{ width: '100%', borderRadius: '12px', overflow: 'hidden' }} />
        ) : (
          <p style={{ color: '#B45309', backgroundColor: '#FEF3C7', padding: '10px', borderRadius: '8px', fontSize: '14px', textAlign: 'center' }}>
            Caméra indisponible. Entrez le numéro de la machine ci-dessous.
          </p>
        )}

        <div style={{ display: 'flex', gap: '8px', marginTop: '16px' }}>
          <input
            value={manualId}
            onChange={(e) => setManualId(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submitManual(); }}
            placeholder="N° de la machine (ex. DTA55642, DTA55645...)"
            style={{
              flex: 1, padding: '12px', borderRadius: '8px',
              border: '1px solid #D1D5DB', fontSize: '15px', color: 'black',
            }}
          />
          <button
            onClick={submitManual}
            style={{ padding: '12px 18px', borderRadius: '8px', border: 'none', backgroundColor: '#10B981', color: 'white', fontWeight: 'bold', cursor: 'pointer' }}
          >
            OK
          </button>
        </div>

        <button
          onClick={onClose}
          style={{ marginTop: '12px', width: '100%', padding: '10px', background: 'none', border: 'none', color: '#6B7280', cursor: 'pointer', fontSize: '14px' }}
        >
          Annuler
        </button>
      </div>
    </div>
  );
}
