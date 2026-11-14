import { Link } from 'react-router-dom';

const PAGES = {
  'mentions-legales': {
    title: 'Mentions légales',
    body: [
      'Éditeur du site : [Raison sociale — à compléter]',
      'Adresse : [Adresse — à compléter]',
      'SIRET : [SIRET — à compléter]',
      'Contact : [email / téléphone — à compléter]',
      'Hébergement : Vercel Inc., 340 S Lemon Ave #4133, Walnut, CA 91789, États-Unis.',
      'Version test — document en cours de rédaction.',
    ],
  },
  'cgu': {
    title: 'Conditions Générales d’Utilisation (CGU)',
    body: [
      '1. Objet : les présentes CGU encadrent l’utilisation du service de location de batteries externes Joe Shop.',
      '2. Location : la location débute après pré-autorisation bancaire (caution) et déverrouillage de la batterie.',
      '3. Tarifs : le tarif horaire, les minutes gratuites, le plafond journalier et le montant de la caution sont affichés sur l’écran de location avant validation.',
      '4. Restitution : la batterie doit être restituée dans une station du réseau. Tout retard ou perte peut entraîner des frais supplémentaires.',
      '5. Données : voir notre page Confidentialité.',
      'Version test — document en cours de rédaction.',
    ],
  },
  'confidentialite': {
    title: 'Politique de confidentialité',
    body: [
      'Données collectées : position approximative (carte), informations de paiement (via Stripe), identifiants de location.',
      'Finalités : fourniture du service de location, prévention de la fraude, support client.',
      'Sous-traitants : Mapbox (cartographie), Stripe (paiement).',
      'Vos droits : conformément au RGPD, vous pouvez demander l’accès, la rectification ou la suppression de vos données à [contact — à compléter].',
      'Cookies : des cookies techniques sont déposés pour la carte et le paiement. Voir le bandeau de consentement.',
      'Version test — document en cours de rédaction.',
    ],
  },
};

export default function Legal({ page }) {
  const content = PAGES[page] || PAGES['mentions-legales'];
  return (
    <div style={{ minHeight: '100vh', backgroundColor: '#F9FAFB', padding: '24px 16px', display: 'flex', justifyContent: 'center' }}>
      <div style={{ width: '100%', maxWidth: '720px', backgroundColor: 'white', borderRadius: '16px', padding: '32px 24px', boxShadow: '0 4px 12px rgba(0,0,0,0.06)', height: 'fit-content' }}>
        <h1 style={{ fontSize: '24px', fontWeight: 'bold', color: 'black', margin: '0 0 20px' }}>{content.title}</h1>
        {content.body.map((p, i) => (
          <p key={i} style={{ color: '#374151', fontSize: '15px', lineHeight: 1.7, margin: '0 0 12px' }}>{p}</p>
        ))}
        <Link to="/" style={{ display: 'inline-block', marginTop: '20px', color: '#10B981', fontWeight: 'bold', textDecoration: 'none' }}>
          ← Retour à la carte
        </Link>
      </div>
    </div>
  );
}
