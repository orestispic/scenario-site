/* oxlint-disable next/no-img-element -- Static Vite entry, not the legacy Vinext app. */
import { useEffect, useState, type SyntheticEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserAccount, takeRecoveryHash, validateBrowserConfig, type BrowserAccountConfig } from '../lib/commercial/browser-account';
import type { BillingOfferView } from '../lib/commercial/contracts-v3';
import './site.css';

declare const __SENARIO_PUBLIC_CONFIG__: BrowserAccountConfig;
let initialRecovery = takeRecoveryHash(new URL(location.href), (url) => history.replaceState(null, '', url));
const account = validateBrowserConfig(__SENARIO_PUBLIC_CONFIG__) ? new BrowserAccount(__SENARIO_PUBLIC_CONFIG__) : null;
type AccountView = Awaited<ReturnType<BrowserAccount['account']>>;
const money = (offer: BillingOfferView) => new Intl.NumberFormat('fr-FR', {
  style: 'currency', currency: offer.currency,
}).format(offer.unitAmountMinor / 100);

function App() {
  const [offers, setOffers] = useState<BillingOfferView[]>([]);
  const [catalogError, setCatalogError] = useState('');
  const [view, setView] = useState<AccountView | null>(null);
  const [recoveryHash, setRecoveryHash] = useState(() => { const value = initialRecovery; initialRecovery = null; return value; });
  const [mode, setMode] = useState<'login' | 'signup' | 'reset'>(recoveryHash ? 'reset' : 'login');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');
  useEffect(() => {
    let active = true;
    if (account) void account.catalog().then((catalog) => { if (active) setOffers(catalog.offers); })
      .catch(() => { if (active) setCatalogError('Les offres sont temporairement indisponibles. Réessayez plus tard.'); });
    const close = () => { account?.clear(); setView(null); setRecoveryHash(null); setMode('login'); };
    addEventListener('pagehide', close);
    return () => { active = false; removeEventListener('pagehide', close); account?.clear(); };
  }, []);
  useEffect(() => {
    if (!view || !account) return;
    let active = true;
    const timer = setInterval(() => { void account.token().catch(() => {
      if (active) { setView(null); setMessage('Votre session a expiré. Reconnectez-vous.'); }
    }); }, 30_000);
    return () => { active = false; clearInterval(timer); };
  }, [view]);
  async function perform(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setMessage('');
    try { await action(); } catch (error) { setMessage(error instanceof Error ? error.message : 'Action impossible.'); }
    finally { setBusy(false); }
  }
  async function submit(event: SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const passwordValue = data.get('password');
    const password = typeof passwordValue === 'string' ? passwordValue : '';
    const passwordInput = form.elements.namedItem('password') as HTMLInputElement;
    passwordInput.value = '';
    await perform(async () => {
      if (!account) return;
      if (mode === 'reset' && recoveryHash) {
        try { await account.resetPassword(recoveryHash, password); }
        finally { setRecoveryHash(null); setMode('login'); }
        setMessage('Mot de passe modifié. Connectez-vous avec le nouveau mot de passe.');
      } else if (mode === 'signup') {
        const name = data.get('name');
        await account.signUp(email, password, typeof name === 'string' ? name : '');
        setMode('login'); setMessage('Demande envoyée. Si un e-mail de confirmation est nécessaire, consultez votre messagerie.');
      } else {
        await account.signIn(email, password);
        setView(await account.account()); setMessage('Vous êtes connecté.');
      }
    });
  }
  function offerCards(items: BillingOfferView[], signedIn: boolean) {
    return items.map((offer) => <article className="offer" key={offer.selectionId}>
      <p className="eyebrow">{offer.billingInterval === 'month' ? 'MENSUEL' : 'ANNUEL'}</p>
      <h3>{offer.displayName}</h3><p>{offer.description}</p>
      <p className="price">{money(offer)} <small>/ {offer.billingInterval === 'month' ? 'mois' : 'an'}</small></p>
      {signedIn ? <button className="download" disabled={busy || !offer.testMode} onClick={() => void perform(async () => {
        location.assign(await account!.checkout(offer.selectionId, `${location.origin}${location.pathname}#compte`));
      })}>Essayer cette offre en mode test</button> : <a className="secondary" href="#compte">Se connecter pour essayer</a>}
    </article>);
  }
  return <main>
    <header className="topbar"><a className="brand" href="#accueil" aria-label="senario, accueil"><img src="/scenario-logo.png" alt=""/><span>senario</span></a>
      <nav aria-label="Navigation principale"><a href="#projets">Fonctionnalités</a><a href="#offres">Offres</a><a href="#telecharger">Télécharger</a><a href="#compte">Mon compte</a></nav></header>
    <section className="hero" id="accueil"><div className="hero-copy"><p className="eyebrow">ÉCRIVEZ SEUL. CRÉEZ ENSEMBLE.</p><h1>Votre histoire.<br/>À plusieurs voix.</h1>
      <p className="lead">senario accompagne votre écriture, de la première page au scénario prêt à partager. Gardez vos projets sur votre ordinateur, retrouvez-les dans le cloud ou invitez votre équipe.</p>
      <div className="hero-actions"><a className="download" href="#telecharger">Découvrir la bêta Windows <b>→</b></a><a href="#projets">Explorer les possibilités ↓</a></div>
      <p className="beta-note">Bêta privée · Environnement de test · Aucun paiement réel</p></div>
      <div className="hero-mark" aria-hidden="true"><div className="paper"><div className="fold"/><img src="/scenario-logo.png" alt=""/><i/><i/><i/></div></div></section>
    <section className="features" id="projets" aria-label="Fonctionnalités">
      <article><span>01</span><h2>Écrivez, tout simplement.</h2><p>Scènes, actions, dialogues : la mise en page suit votre écriture. Vos fichiers locaux restent à vous.</p></article>
      <article><span>02</span><h2>Un espace pour vos projets.</h2><p>Une fenêtre dédiée au cloud. Un projet peut rester privé ou être partagé avec les personnes que vous choisissez.</p></article>
      <article><span>03</span><h2>La même histoire, en direct.</h2><p>Invitez des éditeurs ou des lecteurs. Retrouvez les changements de votre équipe et un état clair de la synchronisation.</p></article>
      <article><span>04</span><h2>Tout le projet compte.</h2><p>Premières pages, commentaires, réponses et export PDF : le travail ne se limite pas au texte du scénario.</p></article>
    </section>
    <section className="section" id="offres"><p className="eyebrow">CHOISISSEZ VOTRE FAÇON D’ÉCRIRE</p><h2>Les offres de la bêta</h2>
      <p>Montants affichés par le serveur de test. Aucun abonnement réel n’est vendu sur cette version.</p>
      <div className="offer-grid">{offerCards(offers, false)}</div>
      {!account && <p className="notice">Le catalogue et la connexion seront disponibles lorsque ce site sera relié à son environnement de test.</p>}
      {catalogError && <output className="notice">{catalogError}</output>}
    </section>
    <section className="section" id="telecharger"><p className="eyebrow">PRENDRE LE TEMPS DE BIEN FAIRE</p><h2>La bêta Windows se prépare.</h2>
      <p>Le téléchargement public n’est pas encore ouvert. L’installateur doit terminer ses vérifications de sécurité et de signature avant sa diffusion.</p>
      <p>La version commerciale macOS n’est pas proposée dans cette bêta. Les fichiers <code>.scenario</code> conservent leur format.</p>
    </section>
    <section className="section" id="compte"><p className="eyebrow">VOTRE ESPACE</p><h2>Mon compte senario</h2>
      <p>Compte de test uniquement. Dans le navigateur, une actualisation demande une nouvelle connexion ; aucun jeton n’est conservé dans le stockage du navigateur.</p>
      {!view ? <form className="account-form" onSubmit={(event) => void submit(event)}>
        <fieldset disabled={busy || !account}><legend>{mode === 'reset' ? 'Choisir un nouveau mot de passe' : mode === 'signup' ? 'Créer un compte de test' : 'Connexion'}</legend>
          {mode !== 'reset' && <label>Adresse e-mail<input type="email" name="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required maxLength={254}/></label>}
          {mode === 'signup' && <label>Votre nom<input name="name" autoComplete="name" required maxLength={100}/></label>}
          <label>{mode === 'reset' ? 'Nouveau mot de passe' : 'Mot de passe'}<input type="password" name="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required maxLength={256}/></label>
          {mode === 'login' && <button type="button" className="text-button" onClick={() => void perform(async () => {
            if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Saisissez votre adresse e-mail ci-dessus.');
            await account!.recover(email); setMessage('Si cette adresse possède un compte, un lien de récupération sera envoyé.');
          })}>Mot de passe oublié ?</button>}
          <button className="download" type="submit">{busy ? 'Veuillez patienter…' : mode === 'reset' ? 'Modifier mon mot de passe' : mode === 'signup' ? 'Créer mon compte' : 'Se connecter'}</button>
          {!recoveryHash && <button className="text-button" type="button" onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setMessage(''); }}>{mode === 'login' ? 'Créer un compte de test' : 'J’ai déjà un compte'}</button>}
        </fieldset></form> : <div className="account-summary"><h3>{view.me.account.displayName ?? 'Votre compte'}</h3><p>{view.me.account.email}</p>
          <p>Abonnement : {view.billing.billing.offerDisplayName ?? 'Aucun'} · {({ active: 'actif', none: 'sans abonnement', trialing: 'en essai', past_due: 'à régulariser', paused: 'en pause', canceled: 'résilié', expired: 'expiré' } as const)[view.billing.billing.status]}</p>
          <div className="account-actions"><button className="secondary" disabled={busy} onClick={() => void perform(async () => setView(await account!.account()))}>Actualiser mon compte</button>
            <button className="secondary" disabled={busy} onClick={() => void perform(async () => location.assign(await account!.portal(`${location.origin}${location.pathname}#compte`)))}>Gérer l’abonnement test</button>
            <button className="secondary" disabled={busy} onClick={() => void perform(async () => { setView(null); await account!.signOut(); setMessage('Vous êtes déconnecté.'); })}>Se déconnecter</button></div>
          <div className="offer-grid">{offerCards(view.billing.offers, true)}</div></div>}
      <output className="notice" aria-live="polite">{message || (!account ? 'Connexion indisponible : configuration de test manquante.' : 'Utilisez votre compte de test existant.')}</output>
    </section>
    <section className="section help" id="aide"><h2>Besoin d’un repère ?</h2>
      <details><summary>Comment partager un projet ?</summary><p>Dans l’application, ouvrez « Projets cloud », choisissez votre projet puis son partage. Un projet cloud reste privé tant que vous n’invitez personne.</p></details>
      <details><summary>Où sont mes commentaires et mes premières pages ?</summary><p>Ils font partie du projet. Les éditeurs peuvent les modifier ; les lecteurs les consultent. Une modification concurrente non réconciliable est signalée, jamais effacée en silence.</p></details>
      <details><summary>Que faire si la connexion s’interrompt ?</summary><p>Conservez l’application ouverte le temps de la reconnexion. En cas de conflit, récupérez une copie locale avant de choisir la version à garder. Gardez aussi une sauvegarde personnelle de vos fichiers.</p></details>
      <details><summary>Confidentialité de cette bêta</summary><p>La connexion et les données cloud utilisent Supabase ; l’API et le canal collaboratif utilisent Cloudflare. Stripe est utilisé uniquement en mode test. Aucun outil d’analyse d’audience n’est chargé par cette page. N’y déposez pas de données sensibles pendant les essais.</p><p>Les jetons du site restent en mémoire. Les données de compte et les projets cloud, eux, sont persistants côté serveur. Cette information de bêta ne remplace pas la politique de confidentialité complète, les durées de conservation et les mentions légales à finaliser avant l’ouverture publique.</p></details>
      <p>Le support public et son adresse de contact sont en préparation. Les participants à la bêta passent par leur canal d’échange existant avec l’équipe.</p>
    </section>
    <footer><a className="brand" href="#accueil">senario</a><span>Bêta privée · Publication publique non ouverte</span><a href="#aide">Aide et confidentialité</a></footer>
  </main>;
}

createRoot(document.getElementById('root')!).render(<App/>);
