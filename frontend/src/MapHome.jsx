import { useEffect, useRef, useState, useCallback } from 'react';
import mapboxgl from 'mapbox-gl';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import 'mapbox-gl/dist/mapbox-gl.css';

// ── Production-safe env vars ──
mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN || 'pk.eyJ1IjoicWlhb3l1NTE1IiwiYSI6ImNtdXppb3hxcDBzb28yeXNqY3ZsbDM0cnUifQ.pQrYMN00KDIAzLaVrrkTlA';
const API_BASE = import.meta.env.VITE_API_URL || 'https://powerbank-app-im73.onrender.com';

// NOTE: No hardcoded device IDs or coordinates.
// The /api/nearby endpoint returns lat/lng for every device (including offline ones).
// If a device has no coordinates, it is skipped during marker rendering.

export default function MapHome() {
  const mapContainer = useRef(null);
  const map = useRef(null);
  const markersRef = useRef([]);
  const navigate = useNavigate();

  const [userLocation] = useState([4.101199421590414, 46.009548411992746]);
  const [stations, setStations] = useState([]);
  const [mode, setMode] = useState('rent');
  const [loadError, setLoadError] = useState(null);
  const [retrying, setRetrying] = useState(false);

  // Fetch all fleet stations with graceful error handling
  const fetchStations = useCallback(async () => {
    setLoadError(null);
    setRetrying(true);
    try {
      const res = await axios.get(`${API_BASE}/api/nearby`, { timeout: 30000 });
      if (Array.isArray(res.data)) {
        // ── Ensure every station has numeric lat/lng; filter out ones without valid coordinates ──
        const enriched = res.data.map(station => ({
          ...station,
          lat: parseFloat(station.lat) || 0,
          lng: parseFloat(station.lng) || 0,
        }));
        setStations(enriched);
      } else {
        setStations([]);
      }
    } catch (err) {
      console.error('Map data error:', err);
      setLoadError({
        title: 'Serveur injoignable',
        message: 'Le serveur peut etre en cours de reveil (Render free tier). Reessayez dans quelques secondes.',
        detail: err.code === 'ECONNABORTED' ? 'Delai depasse (timeout)' : (err.message || 'Erreur reseau'),
      });
      setStations([]);
    } finally {
      setRetrying(false);
    }
  }, []);

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

    fetchStations();
  }, [userLocation, fetchStations]);

  // ── Render markers for ALL stations whenever stations or mode changes ──
  useEffect(() => {
    if (!map.current || stations.length === 0) return;

    // Clear old markers
    markersRef.current.forEach(marker => marker.remove());
    markersRef.current = [];

    // ── Collect valid coordinates for auto-fit bounds ──
    const validCoords = [];

    // ── Detect co-located stations (same lat/lng) and apply slight offset ──
    // This ensures overlapping markers are all visible
    const coordMap = new Map(); // "lat,lng" → [station indices]
    stations.forEach((station, index) => {
      if (station.lat && station.lng && !isNaN(station.lat) && !isNaN(station.lng)) {
        const key = `${station.lat.toFixed(6)},${station.lng.toFixed(6)}`;
        if (!coordMap.has(key)) coordMap.set(key, []);
        coordMap.get(key).push(index);
      }
    });

    // Apply offset to co-located stations
    const offsetStations = [...stations];
    coordMap.forEach(indices => {
      if (indices.length > 1) {
        // Spread co-located markers in a small circle around the shared point
        indices.forEach((idx, i) => {
          const angle = (i / indices.length) * 2 * Math.PI;
          const offset = 0.0008; // ~80 meters
          offsetStations[idx] = {
            ...offsetStations[idx],
            lat: offsetStations[idx].lat + offset * Math.cos(angle),
            lng: offsetStations[idx].lng + offset * Math.sin(angle) / Math.cos(offsetStations[idx].lat * Math.PI / 180),
          };
        });
      }
    });

    offsetStations.forEach(station => {
      if (!station.lat || !station.lng || isNaN(station.lat) || isNaN(station.lng)) return;

      const isOnline = station.isOnline !== false;
      const hasBatteries = (station.rentableBatteries || station.availablePowerBanks || 0) > 0;
      const hasEmptySlots = (station.emptySlots || station.emptyReturnSlots || station.freeNum || 0) > 0;

      // ── Determine marker color based on status ──
      let color;
      if (mode === 'rent') {
        if (!isOnline) {
          color = '#9CA3AF'; // grey for offline
        } else if (hasBatteries) {
          color = '#10B981'; // green for available
        } else {
          color = '#EF4444'; // red for empty
        }
      } else {
        // return mode
        if (!isOnline) {
          color = '#9CA3AF'; // grey for offline
        } else if (hasEmptySlots) {
          color = '#3B82F6'; // blue for return available
        } else {
          color = '#EF4444'; // red for full
        }
      }

      // ── Build popup HTML with React-router-compatible navigation ──
      // NOTE: We use a data-device-id attribute + event delegation instead of <a href>
      // because raw <a href> breaks SPA routing in Vite
      const navLink = `https://www.google.com/maps/dir/?api=1&destination=${station.lat},${station.lng}`;
      let popupHTML;

      if (mode === 'rent') {
        const rentBtn = isOnline && hasBatteries
          ? `<button class="popup-rent-btn" data-device-id="${station.id}" style="flex: 1; background: #10B981; color: white; text-align: center; padding: 10px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 14px; border: none; cursor: pointer;">Louer</button>`
          : `<span style="color: ${!isOnline ? '#9CA3AF' : '#EF4444'}; font-weight: bold; text-align: center; width: 100%; display: block; padding: 10px;">${!isOnline ? 'Hors ligne' : 'Vide'}</span>`;

        popupHTML = `
          <div style="padding: 8px; color: black; display: flex; flex-direction: column; gap: 8px; min-width: 200px;">
            <h3 style="font-weight: bold; margin: 0; font-size: 15px;">Station ${station.id}</h3>
            <p style="margin: 0; font-size: 13px;">${station.shopName || 'Power Bank Station'}</p>
            <p style="margin: 0; font-size: 13px;">
              ${isOnline ? `Batteries: ${station.rentableBatteries || station.availablePowerBanks || 0} | Vides: ${station.emptySlots || 0}` : 'Hors ligne'}
            </p>
            <div style="display: flex; gap: 8px; margin-top: 4px;">
              ${rentBtn}
              <a href="${navLink}" target="_blank" rel="noopener noreferrer" style="flex: 1; background: #F3F4F6; color: black; text-align: center; padding: 10px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 14px; border: 1px solid #D1D5DB;">Itineraire</a>
            </div>
          </div>
        `;
      } else {
        const returnInfo = isOnline
          ? `Places vides: <span style="font-size: 1.2em; font-weight: bold;">${station.emptySlots || station.emptyReturnSlots || 0}</span>`
          : 'Hors ligne';

        popupHTML = `
          <div style="padding: 8px; color: black; display: flex; flex-direction: column; gap: 8px; min-width: 200px;">
            <h3 style="font-weight: bold; margin: 0; font-size: 15px;">Station ${station.id}</h3>
            <p style="margin: 0; font-size: 13px;">${station.shopName || 'Power Bank Station'}</p>
            <p style="margin: 0; font-size: 13px;">${returnInfo}</p>
            ${isOnline && hasEmptySlots ? `
              <a href="${navLink}" target="_blank" rel="noopener noreferrer" style="width: 100%; display: block; background: #3B82F6; color: white; text-align: center; padding: 10px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 14px; margin-top: 4px;">Itineraire (Y aller)</a>
            ` : '<p style="color: red; font-weight: bold; margin: 0; text-align: center;">Plein ou hors ligne</p>'}
          </div>
        `;
      }

      // ── Create marker with custom element for better visibility ──
      const markerEl = document.createElement('div');
      markerEl.style.width = '20px';
      markerEl.style.height = '20px';
      markerEl.style.borderRadius = '50%';
      markerEl.style.background = color;
      markerEl.style.border = '3px solid white';
      markerEl.style.boxShadow = '0 2px 6px rgba(0,0,0,0.4)';
      markerEl.style.cursor = 'pointer';

      const marker = new mapboxgl.Marker(markerEl)
        .setLngLat([station.lng, station.lat])
        .setPopup(new mapboxgl.Popup({ offset: 25, closeButton: true }).setHTML(popupHTML))
        .addTo(map.current);

      // ── Event delegation: handle "Louer" button clicks inside popup ──
      marker.getPopup().on('open', () => {
        const popupEl = marker.getPopup().getElement();
        if (!popupEl) return;

        const rentBtn = popupEl.querySelector('.popup-rent-btn');
        if (rentBtn) {
          rentBtn.addEventListener('click', (e) => {
            e.preventDefault();
            const deviceId = e.target.getAttribute('data-device-id');
            if (deviceId) {
              console.log(`[MAP] Navigating to /rent?deviceId=${deviceId}`);
              marker.getPopup().remove();
              navigate(`/rent?deviceId=${deviceId}`);
            }
          });
        }
      });

      markersRef.current.push(marker);

      // Collect valid coordinates for bounds fitting
      validCoords.push([station.lng, station.lat]);
    });

    // ── Auto-fit map bounds to show all fleet stations ──
    if (validCoords.length > 0) {
      if (validCoords.length === 1) {
        map.current.flyTo({ center: validCoords[0], zoom: 15 });
      } else {
        const bounds = validCoords.reduce(
          (b, coord) => b.extend(coord),
          new mapboxgl.LngLatBounds(validCoords[0], validCoords[0])
        );
        map.current.fitBounds(bounds, { padding: 80, maxZoom: 16 });
      }
    }
  }, [stations, mode, navigate]);

  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh', backgroundColor: '#e5e7eb' }}>

      {/* ── Graceful error banner (no white screen) ── */}
      {loadError && (
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, zIndex: 100,
          background: '#fef2f2', borderBottom: '2px solid #ef4444',
          padding: '16px 20px', textAlign: 'center', fontFamily: 'system-ui, sans-serif',
        }}>
          <p style={{ fontSize: '16px', fontWeight: 'bold', color: '#991b1b', marginBottom: '4px' }}>
            {loadError.title}
          </p>
          <p style={{ fontSize: '13px', color: '#7f1d1d', marginBottom: '8px' }}>
            {loadError.message}
          </p>
          <p style={{ fontSize: '12px', color: '#9ca3af', marginBottom: '8px' }}>
            {loadError.detail}
          </p>
          <button
            onClick={fetchStations}
            disabled={retrying}
            style={{
              background: retrying ? '#9ca3af' : '#ef4444', color: 'white',
              border: 'none', padding: '8px 20px', borderRadius: '8px',
              fontWeight: 'bold', cursor: retrying ? 'default' : 'pointer', fontSize: '14px',
            }}
          >
            {retrying ? 'Reveil du serveur...' : 'Reessayer'}
          </button>
        </div>
      )}

      <div style={{ position: 'absolute', top: '30px', left: '50%', transform: 'translateX(-50%)', zIndex: 10, display: 'flex', gap: '5px', backgroundColor: 'white', padding: '6px', borderRadius: '30px', boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1)' }}>
        <button
          onClick={() => setMode('rent')}
          style={{ padding: '12px 24px', borderRadius: '25px', border: 'none', fontWeight: 'bold', cursor: 'pointer', transition: 'all 0.3s', backgroundColor: mode === 'rent' ? '#10B981' : 'transparent', color: mode === 'rent' ? 'white' : '#4B5563' }}
        >
          Emprunter
        </button>
        <button
          onClick={() => setMode('return')}
          style={{ padding: '12px 24px', borderRadius: '25px', border: 'none', fontWeight: 'bold', cursor: 'pointer', transition: 'all 0.3s', backgroundColor: mode === 'return' ? '#3B82F6' : 'transparent', color: mode === 'return' ? 'white' : '#4B5563' }}
        >
          Rendre
        </button>
      </div>

      {/* ── Station count badge ── */}
      {stations.length > 0 && (
        <div style={{
          position: 'absolute', top: '80px', left: '50%', transform: 'translateX(-50%)',
          zIndex: 10, backgroundColor: 'rgba(0,0,0,0.7)', color: 'white',
          padding: '4px 16px', borderRadius: '16px', fontSize: '12px', fontWeight: 'bold',
        }}>
          {stations.length} station{stations.length > 1 ? 's' : ''} · {stations.filter(s => s.isOnline !== false).length} en ligne
        </div>
      )}

      <div ref={mapContainer} style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }} />

      {mode === 'rent' && (
        <div style={{ position: 'absolute', bottom: '40px', left: '50%', transform: 'translateX(-50%)', width: '90%', maxWidth: '400px', zIndex: 10 }}>
          <button
            onClick={() => {
              const scannedId = window.prompt("Entrez le numero de la machine :");
              if (scannedId) navigate(`/rent?deviceId=${scannedId}`);
            }}
            style={{ width: '100%', backgroundColor: 'black', color: 'white', padding: '16px', borderRadius: '12px', fontWeight: 'bold', fontSize: '18px', cursor: 'pointer', border: 'none', boxShadow: '0 10px 15px -3px rgba(0,0,0,0.2)' }}
          >
            Scanner pour louer
          </button>
        </div>
      )}
    </div>
  );
}
