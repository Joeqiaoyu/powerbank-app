import { useState, useEffect } from 'react';

const KEY = 'joe-shop-cookie-consent';

/**
 * Bandeau de consentement cookies (version test).
 * La carte (Mapbox) et le paiement (Stripe) déposent des traceurs techniques.
 */
export default function CookieBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      if (!localStorage.getItem(KEY)) setVisible(true);
    } catch { setVisible(true); }
  }, []);

  if (!visible) return null;

  const accept = () => {
    try { localStorage.setItem(KEY, 'accepted'); } catch { /* ignore */ }
    setVisible(false);
  };

  return (
    <div style={{
      position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 50,
      backgroundColor: '#111827', color: 'white',
      padding: '12px 16px', display: 'flex', alignItems: 'center', gap: '12px',
      boxShadow: '0 -4px 12px rgba(0,0,0,0.2)',
    }}>
      <p style={{ margin: 0, fontSize: '13px', lineHeight: 1.5, flex: 1 }}>
        Nous utilisons des cookies techniques pour la carte et le paiement.{' '}
        <a href="/confidentialite" style={{ color: '#93C5FD', textDecoration: 'underline' }}>
          En savoir plus
        </a>
      </p>
      <button
        onClick={accept}
        style={{
          backgroundColor: '#10B981', color: 'white', border: 'none',
          borderRadius: '8px', padding: '10px 20px', fontWeight: 'bold',
          cursor: 'pointer', fontSize: '14px', whiteSpace: 'nowrap',
        }}
      >
        Accepter
      </button>
    </div>
  );
}
