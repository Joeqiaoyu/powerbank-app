import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { loadStripe } from '@stripe/stripe-js';
import { Elements } from '@stripe/react-stripe-js';
import MapHome from './MapHome';
import RentCheckout from './RentCheckout';
import Legal from './Legal';
import CookieBanner from './CookieBanner';
import 'mapbox-gl/dist/mapbox-gl.css';

// Stripe Public Key Placeholder
const stripePromise = loadStripe('pk_test_51ULgmUK6OwyhbZVLRL9u9VVjZLNPaGEyzhFpMUmYAGxvN6dvVUojgWXbpcekr7Os2fbJ0oCkNM1Q2oTbOxSV8bs600NN8BfTlI');

export default function App() {
  return (
    <Elements stripe={stripePromise}>
      <Router>
        <Routes>
          <Route path="/" element={<MapHome />} />
          <Route path="/rent" element={<RentCheckout />} />
          <Route path="/mentions-legales" element={<Legal page="mentions-legales" />} />
          <Route path="/cgu" element={<Legal page="cgu" />} />
          <Route path="/confidentialite" element={<Legal page="confidentialite" />} />
        </Routes>
        <CookieBanner />
      </Router>
    </Elements>
  );
}
