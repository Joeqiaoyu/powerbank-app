import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { loadStripe } from '@stripe/stripe-js';
import { Elements } from '@stripe/react-stripe-js';
import MapHome from './MapHome';
import RentCheckout from './RentCheckout';
import RentSuccess from './RentSuccess';
import ActiveRental from './ActiveRental';
import RentSummary from './RentSummary';
import AdminQRCodes from './AdminQRCodes';
import 'mapbox-gl/dist/mapbox-gl.css';

// Stripe Public Key
const stripePromise = loadStripe('pk_test_51ULgmUK6OwyhbZVLRL9u9VVjZLNPaGEyzhFpMUmYAGxvN6dvVUojgWXbpcekr7Os2fbJ0oCkNM1Q2oTbOxSV8bs600NN8BfTlI');

export default function App() {
  return (
    <Elements stripe={stripePromise}>
      <Router>
        <Routes>
          <Route path="/" element={<MapHome />} />
          <Route path="/rent" element={<RentCheckout />} />
          <Route path="/rent/success" element={<RentSuccess />} />
          <Route path="/rent/active" element={<ActiveRental />} />
          <Route path="/rent/summary" element={<RentSummary />} />
          <Route path="/admin/qrcodes" element={<AdminQRCodes />} />
        </Routes>
      </Router>
    </Elements>
  );
}
