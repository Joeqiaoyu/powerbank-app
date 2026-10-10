import { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import ScannerModal from './ScannerModal';
import 'mapbox-gl/dist/mapbox-gl.css';

mapboxgl.accessToken = 'pk.eyJ1IjoicWlhb3l1NTE1IiwiYSI6ImNtdXppb3hxcDBzb28yeXNqY3ZsbDM0cnUifQ.pQrYMN00KDIAzLaVrrkTlA';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000';

export default function MapHome() {
  const mapContainer = useRef(null);
  const map = useRef(null);
  const markersRef = useRef([]); 
  const navigate = useNavigate();
  
  const [userLocation] = useState([4.101199421590414, 46.009548411992746]); 
  const [cabinets, setCabinets] = useState([]);
  const [mode, setMode] = useState('rent'); 
  const [showScanner, setShowScanner] = useState(false);
  const [showInfo, setShowInfo] = useState(false);

  // Le QR peut contenir soit l'ID brut, soit une URL avec ?deviceId=...
  const handleScanned = (text) => {
    setShowScanner(false);
    let deviceId = (text || '').trim();
    try {
      const url = new URL(text);
      deviceId = url.searchParams.get('deviceId') || url.searchParams.get('device') || deviceId;
    } catch (e) { /* pas une URL : on garde le texte brut */ }
    if (deviceId) navigate(`/rent?deviceId=${encodeURIComponent(deviceId)}`);
  };

  useEffect(() => {
    if (map.current) return;
    
    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/streets-v12',
      center: userLocation,
      zoom: 14
    });

    // Add high-accuracy GPS tracking button
    map.current.addControl(
      new mapboxgl.GeolocateControl({
        positionOptions: { enableHighAccuracy: true },
        trackUserLocation: true,
        showUserHeading: true
      }),
      'bottom-right'
    );

    axios.get(`${API_BASE}/api/nearby`)
      .then((res) => {
        if (Array.isArray(res.data)) setCabinets(res.data);
      })
      .catch(err => console.error("Map data error:", err));
  }, [userLocation]);

  useEffect(() => {
    if (!map.current || cabinets.length === 0) return;

    markersRef.current.forEach(marker => marker.remove());
    markersRef.current = [];

    cabinets.forEach(cab => {
      let isAvailable = false;
      let color = '#EF4444'; 
      let popupHTML = '';
      
      // Universal routing link
      const navLink = `https://www.google.com/maps/dir/?api=1&destination=${cab.lat},${cab.lng}`;

      if (mode === 'rent') {
        isAvailable = cab.rentableBatteries > 0;
        color = isAvailable ? '#10B981' : '#EF4444'; 
        popupHTML = `
          <div style="padding: 8px; color: black; display: flex; flex-direction: column; gap: 8px;">
            <h3 style="font-weight: bold; margin: 0;">Station ${cab.id}</h3>
            <p style="margin: 0; font-size: 14px;">Batteries: ${cab.rentableBatteries} | Vides: ${cab.emptySlots}</p>
            <div style="display: flex; gap: 8px; margin-top: 4px;">
              ${isAvailable ? `<a href="/rent?deviceId=${cab.id}" style="flex: 1; background: #10B981; color: white; text-align: center; padding: 8px; border-radius: 6px; text-decoration: none; font-weight: bold; font-size: 14px;">Louer</a>` : '<span style="color: red; font-weight: bold; text-align: center; width: 100%;">Vide</span>'}
              <a href="${navLink}" target="_blank" rel="noopener noreferrer" style="flex: 1; background: #F3F4F6; color: black; text-align: center; padding: 8px; border-radius: 6px; text-decoration: none; font-weight: bold; font-size: 14px; border: 1px solid #D1D5DB;">🧭 Itinéraire</a>
            </div>
          </div>
        `;
      } else {
        isAvailable = cab.emptySlots > 0;
        color = isAvailable ? '#3B82F6' : '#EF4444'; 
        popupHTML = `
          <div style="padding: 8px; color: black; display: flex; flex-direction: column; gap: 8px;">
            <h3 style="font-weight: bold; margin: 0;">Station ${cab.id}</h3>
            <p style="margin: 0; font-size: 14px;">Places vides: <span style="font-size: 1.2em; font-weight: bold;">${cab.emptySlots}</span></p>
            ${isAvailable ? `
              <a href="${navLink}" target="_blank" rel="noopener noreferrer" style="width: 100%; display: block; background: #3B82F6; color: white; text-align: center; padding: 10px; border-radius: 6px; text-decoration: none; font-weight: bold; font-size: 14px; margin-top: 4px;">🧭 Itinéraire (Y aller)</a>
            ` : '<p style="color: red; font-weight: bold; margin: 0; text-align: center;">Plein (Ne pas aller)</p>'}
          </div>
        `;
      }

      const marker = new mapboxgl.Marker({ color })
        .setLngLat([cab.lng, cab.lat])
        .setPopup(new mapboxgl.Popup().setHTML(popupHTML))
        .addTo(map.current);
        
      markersRef.current.push(marker); 
    });
  }, [cabinets, mode]);

  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh', backgroundColor: '#e5e7eb' }}>
      
      <div style={{ position: 'absolute', top: '30px', left: '50%', transform: 'translateX(-50%)', zIndex: 10, display: 'flex', gap: '5px', backgroundColor: 'white', padding: '6px', borderRadius: '30px', boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1)' }}>
        <button 
          onClick={() => setMode('rent')}
          style={{ padding: '12px 24px', borderRadius: '25px', border: 'none', fontWeight: 'bold', cursor: 'pointer', transition: 'all 0.3s', backgroundColor: mode === 'rent' ? '#10B981' : 'transparent', color: mode === 'rent' ? 'white' : '#4B5563' }}
        >
          🔋 Emprunter
        </button>
        <button 
          onClick={() => setMode('return')}
          style={{ padding: '12px 24px', borderRadius: '25px', border: 'none', fontWeight: 'bold', cursor: 'pointer', transition: 'all 0.3s', backgroundColor: mode === 'return' ? '#3B82F6' : 'transparent', color: mode === 'return' ? 'white' : '#4B5563' }}
        >
          🔌 Rendre
        </button>
      </div>

      <div ref={mapContainer} style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }} />
      
      {mode === 'rent' && (
        <div style={{ position: 'absolute', bottom: '40px', left: '50%', transform: 'translateX(-50%)', width: '90%', maxWidth: '400px', zIndex: 10 }}>
          <button 
            onClick={() => setShowScanner(true)}
            style={{ width: '100%', backgroundColor: 'black', color: 'white', padding: '16px', borderRadius: '12px', fontWeight: 'bold', fontSize: '18px', cursor: 'pointer', border: 'none', boxShadow: '0 10px 15px -3px rgba(0,0,0,0.2)' }}
          >
            📷 Scanner pour louer
          </button>
        </div>
      )}

      {/* Bouton info : liens légaux */}
      <div style={{ position: 'absolute', top: '30px', right: '16px', zIndex: 10 }}>
        <button
          onClick={() => setShowInfo(!showInfo)}
          style={{ width: '40px', height: '40px', borderRadius: '50%', border: 'none', backgroundColor: 'white', boxShadow: '0 4px 6px rgba(0,0,0,0.1)', fontSize: '18px', cursor: 'pointer', fontWeight: 'bold', color: '#4B5563' }}
          aria-label="Informations légales"
        >
          ⓘ
        </button>
        {showInfo && (
          <div style={{ position: 'absolute', top: '48px', right: 0, backgroundColor: 'white', borderRadius: '12px', boxShadow: '0 10px 15px -3px rgba(0,0,0,0.15)', padding: '8px 0', minWidth: '180px' }}>
            {[
              ['/mentions-legales', 'Mentions légales'],
              ['/cgu', 'CGU'],
              ['/confidentialite', 'Confidentialité'],
            ].map(([href, label]) => (
              <a key={href} href={href} style={{ display: 'block', padding: '10px 16px', color: '#1F2937', textDecoration: 'none', fontSize: '14px' }}>
                {label}
              </a>
            ))}
          </div>
        )}
      </div>

      {showScanner && (
        <ScannerModal onScan={handleScanned} onClose={() => setShowScanner(false)} />
      )}
    </div>
  );
}
