/* oxlint-disable next/no-img-element, next/no-html-link-for-pages -- Static Vite entry with native history navigation. */
import {
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type SyntheticEvent,
} from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowRight,
  FileText,
  Cloud,
  Users,
  MessageSquare,
  Download,
  LockKeyhole,
  Mail,
  Check,
  ChevronRight,
  Menu,
  X,
  PenLine,
  History,
  ArrowUpRight,
  RefreshCw,
  MonitorDown,
} from 'lucide-react';
import {
  BrowserAccount,
  takeEmailLink,
  validateBrowserConfig,
  type EmailLink,
  type BrowserAccountConfig,
} from '../lib/commercial/browser-account';
import { InformationPages } from './information';
import type {
  PublicPlanCode,
  PublicPlanView,
} from '../lib/commercial/contracts-v11';
import './site.css';

declare const __SENARIO_PUBLIC_CONFIG__: BrowserAccountConfig;
let initialEmailAction = takeEmailLink(new URL(location.href), (url) =>
  history.replaceState(null, '', url),
);
const account = validateBrowserConfig(__SENARIO_PUBLIC_CONFIG__)
  ? new BrowserAccount(__SENARIO_PUBLIC_CONFIG__)
  : null;
type AccountView = Awaited<ReturnType<BrowserAccount['account']>>;
const routes: Record<string, string> = {
  '/': 'la meilleure page blanche',
  '/offres': 'Offres et FAQ',
  '/telecharger': 'Télécharger Senario',
  '/compte': 'Mon compte',
  '/connexion': 'Connexion',
  '/reinitialisation': 'Mot de passe oublié',
  '/contact': 'Contact',
  '/confidentialite': 'Confidentialité',
  '/conditions': 'Conditions de la bêta',
  '/mentions': 'Mentions légales',
};
const legacy: Record<string, string> = {
  '#accueil': '/',
  '#projets': '/',
  '#telecharger': '/telecharger',
  '#offres': '/offres',
  '#aide': '/offres',
  '#compte': '/compte',
  '#support': '/contact',
  '#confidentialite': '/confidentialite',
  '#conditions': '/conditions',
  '#mentions': '/mentions',
};
function currentRoute() {
  return legacy[location.hash] ?? (location.pathname.replace(/\/$/, '') || '/');
}
const money = (amount: number, currency: string) =>
  new Intl.NumberFormat('fr-FR', { style: 'currency', currency }).format(
    amount / 100,
  );

// The API remains the source of truth for prices and eligibility. This copy is
// deliberately kept in the website so the benefits stay easy to compare.
const offerPresentation: Record<
  PublicPlanCode,
  { description: string; features: readonly string[] }
> = {
  discovery: {
    description: 'L’essentiel pour écrire un scénario soigné, dès la première page.',
    features: [
      'Éditeur de scénario avec mise en page automatique et professionnelle',
    ],
  },
  author_ai: {
    description: 'Tout ce qu’il faut pour écrire plus vite, affiner votre texte et préparer vos livrables.',
    features: [
      'Tout ce qui est inclus dans l’offre Gratuite',
      'IA d’écriture pour corriger et améliorer vos textes',
      'IA pour traduire vos exports',
      'Exports professionnels : Final Draft, Fountain et Word',
      'Workspace Whiteboard pour organiser vos idées visuellement',
      'Lecture vocale de votre scénario',
      'Historique des versions intégré à chaque projet',
      'Timeline pour structurer le rythme et la chronologie',
    ],
  },
  studio: {
    description: 'Le workspace complet pour conserver, préparer et partager vos projets de production.',
    features: [
      'Tout ce qui est inclus dans l’offre Auteur',
      '5 Go de stockage dans le Workspace Cloud',
      'Workspace Dépouillement pour préparer la production',
      'Workspace Découpage technique pour passer du scénario au tournage',
      'Projets partagés avec votre équipe',
      '2 000 crédits IA par mois — plus de 3× le quota Auteur',
      'Commentaires partagés pour centraliser les retours',
      'Sauvegarde cloud automatique de vos projets',
    ],
  },
};

const features = [
  {
    Icon: PenLine,
    title: 'Écrire un scénario',
    text: 'Passez d’une scène à un dialogue. Les personnages, les actions et les répliques gardent leur mise en page.',
  },
  {
    Icon: Cloud,
    title: 'Retrouver ses projets',
    text: 'Gardez vos fichiers sur votre ordinateur ou enregistrez un projet dans le cloud. Il reste privé tant que vous ne le partagez pas.',
  },
  {
    Icon: Users,
    title: 'Écrire à plusieurs',
    text: 'Invitez un éditeur pour écrire ensemble, ou un lecteur pour consulter le projet. Les modifications s’affichent en direct.',
  },
  {
    Icon: MessageSquare,
    title: 'Commenter et répondre',
    text: 'Ajoutez une remarque au projet, répondez à votre équipe et marquez les discussions résolues.',
  },
  {
    Icon: FileText,
    title: 'Préparer les premières pages',
    text: 'Renseignez le titre, les auteurs et les informations de votre projet. Les premières pages suivent le scénario.',
  },
  {
    Icon: Download,
    title: 'Exporter et conserver',
    text: 'Exportez un PDF pour la lecture. Gardez un fichier .scenario pour continuer à modifier votre projet.',
  },
];
const windowsDownloadUrl =
  'https://github.com/orestispic/scenario-app/releases/latest/download/Scenario-Setup.exe';
const faq = [
  [
    'Est-ce que l’IA peut écrire à ma place ?',
    'Non. Senario est conçu pour vous aider à améliorer un texte déjà écrit, pas pour écrire votre scénario à votre place. L’IA peut notamment corriger la formulation et aller plus loin sur l’orthographe, tout en vous laissant maître de votre histoire et de vos choix.',
  ],
  [
    'Puis-je écrire sans connexion ?',
    'Oui. Aucun compte n’est requis pour écrire, enregistrer et rouvrir vos fichiers locaux. Connectez-vous seulement pour activer les fonctions Auteur ou Studio. La synchronisation cloud et la collaboration demandent aussi Internet.',
  ],
  [
    'Mes collaborateurs ont-ils besoin de Studio pour voir mon projet ?',
    'Non. Les collaborateurs invités en tant que lecteurs peuvent consulter un projet partagé sans souscrire à l’offre Studio. Studio est nécessaire au propriétaire du projet pour le partager et travailler avec son équipe.',
  ],
  [
    'Quand les fonctionnalités payantes sont-elles activées ?',
    'Après la confirmation de paiement par Stripe. Vous pouvez ensuite retrouver et gérer votre abonnement depuis votre compte.',
  ],
  [
    'Un projet cloud est-il forcément partagé ?',
    'Non. Un projet cloud reste privé tant que vous n’invitez personne. Vous choisissez les éditeurs et les lecteurs projet par projet.',
  ],
  [
    'Puis-je télécharger l’application ?',
    'Oui. La bêta est disponible pour Windows 10 et 11 en 64 bits. Elle vérifie ensuite automatiquement les nouvelles versions signées. La version macOS n’est pas encore publiée.',
  ],
  [
    'Comment conserver une copie de mon travail ?',
    'Enregistrez votre projet au format .scenario. Un PDF permet de le lire, mais ne remplace pas le fichier modifiable. En cas de conflit cloud, conservez une copie locale avant de choisir une version.',
  ],
];

function EditorPreview() {
  return (
    <div
      className="editor-preview"
      aria-label="Exemple de mise en page d’un scénario"
    >
      <div className="editor-title">
        <div className="window-controls">
          <i />
          <i />
          <i />
        </div>
        <span>Le dernier départ.scenario</span>
        <LockKeyhole size={13} />
      </div>
      <div className="editor-tools">
        <span>
          <FileText size={14} /> Scénario
        </span>
        <span>Premières pages</span>
        <span className="tool-comment">
          <MessageSquare size={14} /> Commentaires
        </span>
      </div>
      <div className="editor-body">
        <aside className="scene-list">
          <small>SCÈNES</small>
          <div className="active">
            01 <span>La gare</span>
          </div>
          <div>
            02 <span>Le quai</span>
          </div>
          <div>
            03 <span>Le départ</span>
          </div>
          <div className="preview-local">
            <Cloud size={13} /> Projet privé
          </div>
        </aside>
        <div className="script-page">
          <div className="script-meta">
            LE DERNIER DÉPART <span>1.</span>
          </div>
          <p className="scene-heading">INT. GARE — NUIT</p>
          <p>Le hall est vide. Une horloge indique 23 h 58.</p>
          <p>
            JULIE pose sa valise. De l’autre côté de la vitre, un train attend.
          </p>
          <div className="dialogue">
            <b>JULIE</b>
            <p>On a encore le temps.</p>
          </div>
          <p>
            Elle sourit et pousse la porte.
            <span className="caret" />
          </p>
          <div className="script-end">1 scène · 1 page</div>
        </div>
      </div>
      <div className="editor-bottom">
        <span>
          <span className="status-dot" /> Exemple de document
        </span>
        <span>100 %</span>
      </div>
    </div>
  );
}

function App() {
  const [initialAction] = useState(() => {
    const action = initialEmailAction;
    initialEmailAction = null;
    return action;
  });
  const [emailLink, setEmailLink] = useState<EmailLink | null>(() =>
    initialAction?.type === 'error' ? null : initialAction,
  );
  const [route, setRoute] = useState(() =>
    initialAction
      ? (initialAction.type === 'error' ? initialAction.target : initialAction.type) === 'recovery'
        ? '/reinitialisation'
        : '/connexion'
      : currentRoute(),
  );
  const [plans, setPlans] = useState<PublicPlanView[]>([]);
  const [interval, setIntervalChoice] = useState<'year' | 'month'>('year');
  const [catalogError, setCatalogError] = useState('');
  const [view, setView] = useState<AccountView | null>(null);
  const [mode, setMode] = useState<'login' | 'signup'>(() =>
    new URL(location.href).searchParams.has('inscription') ? 'signup' : 'login',
  );
  const [message, setMessage] = useState(
    initialAction?.type === 'error' ? initialAction.message : '',
  );
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [email, setEmail] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const recoveryLink = emailLink?.type === 'recovery' ? emailLink : null;
  const hasEmailSession = emailLink !== null && 'session' in emailLink;
  function navigate(path: string, preserveMessage = false) {
    if (location.pathname !== path || location.hash)
      history.pushState(null, '', path);
    setRoute(path);
    setMenuOpen(false);
    if (!preserveMessage) setMessage('');
    if (path !== '/reinitialisation' && path !== '/connexion')
      setEmailLink(null);
  }
  function internalLink(event: MouseEvent<HTMLDivElement>) {
    const anchor = (event.target as Element).closest('a');
    if (
      !anchor ||
      event.defaultPrevented ||
      event.button !== 0 ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey ||
      anchor.target ||
      anchor.hasAttribute('download')
    )
      return;
    const url = new URL(anchor.href);
    if (url.origin !== location.origin || !(url.pathname in routes) || url.hash)
      return;
    event.preventDefault();
    if (url.pathname === '/connexion')
      setMode(url.searchParams.has('inscription') ? 'signup' : 'login');
    navigate(url.pathname);
  }
  const initialRoute = useRef(route);
  useEffect(() => {
    history.replaceState(null, '', initialRoute.current);
  }, []);
  useEffect(() => {
    // Supabase has already validated a standard confirmation link before
    // returning the temporary session in the URL fragment. Keep no token in
    // the address bar or page state after showing the confirmation result.
    if (emailLink?.type !== 'signup' || !hasEmailSession) return;
    setEmailLink(null);
    setMode('login');
    setMessage('Adresse confirmée. Vous pouvez maintenant vous connecter.');
  }, [emailLink, hasEmailSession]);
  useEffect(() => {
    let active = true;
    if (account)
      void account
        .catalog()
        .then((catalog) => {
          if (active) setPlans(catalog.plans);
        })
        .catch(() => {
          if (active)
            setCatalogError(
              'Les offres ne sont pas disponibles pour le moment. Réessayez dans quelques minutes.',
            );
        });
    const close = () => {
      account?.clear();
      setView(null);
      setEmailLink(null);
    };
    const navigation = () => {
      const action = takeEmailLink(new URL(location.href), (url) =>
        history.replaceState(null, '', url),
      );
      let next = currentRoute();
      if (action) {
        account?.clear();
        setView(null);
        if (action.type === 'error') {
          setEmailLink(null);
          setMessage(action.message);
          next = action.target === 'recovery' ? '/reinitialisation' : '/connexion';
        } else {
          setEmailLink(action);
          setMessage('');
          next = action.type === 'recovery' ? '/reinitialisation' : '/connexion';
        }
      } else setEmailLink(null);
      history.replaceState(null, '', next);
      setRoute(next);
      if (!action) setMessage('');
      setMenuOpen(false);
    };
    addEventListener('popstate', navigation);
    addEventListener('hashchange', navigation);
    addEventListener('pagehide', close);
    return () => {
      active = false;
      removeEventListener('popstate', navigation);
      removeEventListener('hashchange', navigation);
      removeEventListener('pagehide', close);
      account?.clear();
    };
  }, []);
  useEffect(() => {
    document.title = `senario — ${routes[route] ?? 'Page introuvable'}`;
    window.scrollTo(0, 0);
    document.getElementById('page-title')?.focus({ preventScroll: true });
  }, [route]);
  useEffect(() => {
    if (!view || !account) return;
    let active = true;
    const timer = setInterval(() => {
      void account.token().catch(() => {
        if (active) {
          setView(null);
          setMessage('Votre session a expiré. Reconnectez-vous.');
        }
      });
    }, 30_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [view]);
  async function perform(action: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setMessage('');
    try {
      await action();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : 'Action impossible. Réessayez.',
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function submit(event: SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const passwordValue = data.get('password');
    const password = typeof passwordValue === 'string' ? passwordValue : '';
    if (
      route === '/reinitialisation' &&
      recoveryLink &&
      password !== data.get('confirmation')
    ) {
      setMessage('Les deux mots de passe ne sont pas identiques.');
      return;
    }
    for (const input of form.querySelectorAll<HTMLInputElement>(
      'input[type="password"]',
    ))
      input.value = '';
    await perform(async () => {
      if (!account)
        throw new Error('La connexion est momentanément indisponible.');
      if (route === '/reinitialisation') {
        if (recoveryLink) {
          setView(null);
          await account.resetPassword(recoveryLink, password);
          setEmailLink(null);
          setMode('login');
          navigate('/connexion', true);
          setMessage(
            'Mot de passe modifié. Connectez-vous avec le nouveau mot de passe.',
          );
        } else {
          await account.recover(email, `${location.origin}/reinitialisation`);
          setMessage(
            'Si cette adresse possède un compte, un lien de récupération sera envoyé. Consultez aussi vos courriers indésirables.',
          );
        }
      } else if (mode === 'signup') {
        const name = data.get('name');
        await account.signUp(
          email,
          password,
          typeof name === 'string' ? name : '',
          `${location.origin}/connexion`,
        );
        setMode('login');
        setMessage(
          'Demande envoyée. Consultez votre messagerie pour confirmer votre adresse.',
        );
      } else {
        await account.signIn(email, password);
        setView(await account.account());
        navigate('/compte', true);
        setMessage('Vous êtes connecté.');
      }
    });
  }
  const notice =
    message || (!account ? 'La connexion est momentanément indisponible.' : '');
  const catalogueInTestMode = plans.some((plan) =>
    plan.prices.some((price) => price.testMode),
  );
  function title(kicker: string, heading: string, description: string) {
    return (
      <div className="page-heading">
        <p className="eyebrow">{kicker}</p>
        <h1 id="page-title" tabIndex={-1}>
          {heading}
        </h1>
        <p className="lead">{description}</p>
      </div>
    );
  }
  function billingSwitch() {
    const monthly = interval === 'month';
    return (
      <div className="billing-control">
        <span className={monthly ? 'selected' : ''}>Mensuel</span>
        <button
          className="billing-switch"
          type="button"
          role="switch"
          aria-checked={!monthly}
          aria-label={
            monthly ? 'Afficher les prix annuels' : 'Afficher les prix mensuels'
          }
          onClick={() => setIntervalChoice(monthly ? 'year' : 'month')}
        >
          <i />
        </button>
        <span className={!monthly ? 'selected' : ''}>Annuel</span>
      </div>
    );
  }
  function offers() {
    return plans.map((plan) => {
      const free = plan.offerCode === 'discovery';
      const presentation = offerPresentation[plan.offerCode];
      const selected = plan.prices.find(
        (p) => p.billingInterval === (free ? 'none' : interval),
      );
      if (!selected)
        return (
          <article className="offer" key={plan.offerCode}>
            <h3>{plan.displayName}</h3>
            <p>Cette formule est temporairement indisponible.</p>
          </article>
        );
      const monthly = plan.prices.find((p) => p.billingInterval === 'month');
      const yearly = plan.prices.find((p) => p.billingInterval === 'year');
      const annual = interval === 'year' && !free && yearly;
      const saving =
        monthly && yearly && monthly.currency === yearly.currency
          ? monthly.unitAmountMinor * 12 - yearly.unitAmountMinor
          : 0;
      return (
        <article
          className={`offer${plan.featured ? ' featured' : ''}`}
          key={plan.offerCode}
        >
          <div className="offer-label">
            <h3>{plan.displayName}</h3>
            {plan.featured && <span className="badge">Écriture + IA</span>}
          </div>
          <p className="offer-description">{presentation.description}</p>
          <p className="price">
            {money(
              annual ? yearly.unitAmountMinor / 12 : selected.unitAmountMinor,
              selected.currency,
            )}
            <small>/ mois</small>
          </p>
          <p className="billing-detail">
            {free
              ? 'Gratuit, sans limite de durée'
              : annual
                ? `${money(yearly.unitAmountMinor, yearly.currency)} facturés par an`
                : 'Facturation mensuelle'}
          </p>
          <p className="saving">
            {annual && saving > 0
              ? `${money(saving, selected.currency)} économisés par an`
              : '\u00a0'}
          </p>
          {view ? (
            free ? (
              <a className="button secondary" href="/telecharger">
                Télécharger gratuitement <ArrowRight size={16} />
              </a>
            ) : (
              <button
                className={`button ${plan.featured ? 'primary' : 'secondary'}`}
                disabled={busy || !selected.selectionId}
                onClick={() =>
                  void perform(async () => {
                    location.assign(
                      await account!.checkout(
                        selected.selectionId!,
                        `${location.origin}/compte`,
                      ),
                    );
                  })
                }
              >
                {selected.testMode
                  ? `Essayer ${plan.displayName} en mode test`
                  : `Choisir ${plan.displayName}`}{' '}
                <ArrowUpRight size={16} />
              </button>
            )
          ) : (
            <a
              className={`button ${plan.featured ? 'primary' : 'secondary'}`}
              href={free ? '/telecharger' : '/connexion'}
            >
              {free ? 'Télécharger gratuitement' : `Essayer ${plan.displayName}`}
              <ArrowRight size={16} />
            </a>
          )}
          <ul className="offer-features">
            {presentation.features.map((feature) => (
              <li key={feature}>
                <Check size={16} />
                <span>{feature}</span>
              </li>
            ))}
          </ul>
        </article>
      );
    });
  }
  function authForm() {
    const reset = route === '/reinitialisation';
    return (
      <div className="auth-card">
        {emailLink?.type === 'signup' ? (
          <>
            <div className="icon-box">
              <Mail />
            </div>
            <h2>Confirmez votre adresse</h2>
            <p>Cliquez ci-dessous pour terminer votre inscription.</p>
            <button
              className="button primary"
              disabled={busy || !account}
              onClick={() =>
                void perform(async () => {
                  const link = emailLink;
                  if (!link) throw new Error('Lien de confirmation invalide.');
                  await account!.confirmEmail(link);
                  setEmailLink(null);
                  setMode('login');
                  setMessage('Adresse confirmée. Vous pouvez vous connecter.');
                })
              }
            >
              {busy ? 'Confirmation…' : 'Confirmer mon adresse'}
            </button>
            <button className="text-button" onClick={() => setEmailLink(null)}>
              Revenir à la connexion
            </button>
          </>
        ) : (
          <form
            className="account-form"
            onSubmit={(event) => void submit(event)}
          >
            <fieldset disabled={busy || !account}>
              <legend>
                {reset
                  ? recoveryLink
                    ? 'Choisir un nouveau mot de passe'
                    : 'Recevoir un lien par e-mail'
                  : mode === 'signup'
                    ? 'Créer un compte'
                    : 'Se connecter'}
              </legend>
              {(!reset || !recoveryLink) && (
                <label>
                  Adresse e-mail
                  <input
                    type="email"
                    name="email"
                    autoComplete="email"
                    placeholder="vous@exemple.fr"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    maxLength={254}
                  />
                </label>
              )}
              {!reset && mode === 'signup' && (
                <label>
                  Votre nom
                  <input
                    name="name"
                    autoComplete="name"
                    required
                    maxLength={100}
                  />
                </label>
              )}
              {(!reset || recoveryLink) && (
                <label>
                  {reset ? 'Nouveau mot de passe' : 'Mot de passe'}
                  <input
                    type="password"
                    name="password"
                    autoComplete={
                      !reset && mode === 'login'
                        ? 'current-password'
                        : 'new-password'
                    }
                    required
                    minLength={reset || mode === 'signup' ? 8 : undefined}
                    maxLength={256}
                  />
                </label>
              )}
              {reset && recoveryLink && (
                <label>
                  Confirmer le mot de passe
                  <input
                    type="password"
                    name="confirmation"
                    autoComplete="new-password"
                    required
                    minLength={8}
                    maxLength={256}
                  />
                </label>
              )}
              {!reset && mode === 'login' && (
                <a className="forgot-link" href="/reinitialisation">
                  Mot de passe oublié ?
                </a>
              )}
              <button className="button primary" type="submit">
                {busy
                  ? 'Veuillez patienter…'
                  : reset
                    ? recoveryLink
                      ? 'Modifier mon mot de passe'
                      : 'Envoyer le lien'
                    : mode === 'signup'
                      ? 'Créer mon compte'
                      : 'Se connecter'}
                <ArrowRight size={16} />
              </button>
            </fieldset>
          </form>
        )}
        {emailLink?.type !== 'signup' &&
          (!reset ? (
            <p className="form-footer">
              {mode === 'login' ? 'Pas encore de compte ?' : 'Déjà un compte ?'}{' '}
              <button
                className="text-button"
                onClick={() => {
                  setMode(mode === 'login' ? 'signup' : 'login');
                  setMessage('');
                }}
              >
                {mode === 'login' ? 'Créer un compte' : 'Se connecter'}
              </button>
            </p>
          ) : (
            <a className="back-link" href="/connexion">
              Revenir à la connexion
            </a>
          ))}
        {notice && <output className="notice">{notice}</output>}
      </div>
    );
  }

  // Native anchors emit click for keyboard activation; this handler delegates navigation only.
  return (
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
    <div className="site-shell" onClick={internalLink}>
      <a className="skip-link" href="#contenu">
        Aller au contenu
      </a>
      <header className="topbar">
        <a className="brand" href="/" aria-label="senario, accueil">
          <img src="/scenario-logo.png" alt="" />
          <span>senario</span>
        </a>
        <span className="beta-label">BÊTA</span>
        <a className="button primary mobile-offers" href="/offres">
          Offres
        </a>
        <button
          className="menu-toggle"
          aria-label={menuOpen ? 'Fermer le menu' : 'Ouvrir le menu'}
          aria-expanded={menuOpen}
          aria-controls="navigation"
          onClick={() => setMenuOpen(!menuOpen)}
        >
          {menuOpen ? <X /> : <Menu />}
        </button>
        <nav
          id="navigation"
          className={menuOpen ? 'open' : ''}
          aria-label="Navigation principale"
        >
          <a aria-current={route === '/' ? 'page' : undefined} href="/">
            Fonctionnalités
          </a>
          <a
            aria-current={route === '/telecharger' ? 'page' : undefined}
            href="/telecharger"
          >
            Télécharger
          </a>
          <a
            aria-current={route === '/contact' ? 'page' : undefined}
            href="/contact"
          >
            Contact
          </a>
          <a
            aria-current={
              route === '/compte' || route === '/connexion' ? 'page' : undefined
            }
            href={view ? '/compte' : '/connexion'}
          >
            {view ? 'Mon compte' : 'Connexion'}
          </a>
          <a
            className="button primary nav-offers"
            aria-current={route === '/offres' ? 'page' : undefined}
            href="/offres"
          >
            Voir les offres <ArrowUpRight size={15} />
          </a>
        </nav>
      </header>
      <main id="contenu">
        {route === '/' && (
          <>
            <section className="hero container">
              <div className="hero-copy">
                <p className="eyebrow">
                  <span className="tiny-line" /> LE LOGICIEL D’ÉCRITURE DE
                  SCÉNARIO
                </p>
                <h1 id="page-title" tabIndex={-1}>
                  la meilleure
                  <br />
                  page blanche<span className="blue-period">.</span>
                </h1>
                <p className="lead">
                  Écrivez votre scénario. Mettez-le en page.
                  <br className="desktop-break" /> Partagez-le avec les bonnes
                  personnes.
                </p>
                <div className="hero-actions">
                  <a className="button primary" href="/offres">
                    Trouver mon offre <ArrowRight size={17} />
                  </a>
                  <a
                    className="button secondary"
                    href="/connexion?inscription=1"
                  >
                    Créer un compte
                  </a>
                </div>
                <p className="quiet-note">
                  Bêta disponible · Paiement sécurisé par Stripe
                </p>
              </div>
              <EditorPreview />
            </section>
            <div className="feature-strip">
              <div className="container">
                <span>
                  <FileText size={17} /> Fichiers .scenario
                </span>
                <span>
                  <Cloud size={17} /> Cloud privé ou partagé
                </span>
                <span>
                  <Users size={17} /> Écriture en direct
                </span>
                <span>
                  <Download size={17} /> Export PDF
                </span>
              </div>
            </div>
            <section className="container feature-section">
              <div className="section-heading">
                <p className="eyebrow">DE LA PREMIÈRE SCÈNE AU PDF</p>
                <h2>Écriture, partage et export.</h2>
                <p>
                  Un éditeur pour écrire, relire et travailler sur un même
                  projet.
                </p>
              </div>
              <div className="feature-grid">
                {features.map(({ Icon, title: heading, text }) => (
                  <article key={heading}>
                    <div className="icon-box">
                      <Icon size={21} />
                    </div>
                    <h3>{heading}</h3>
                    <p>{text}</p>
                  </article>
                ))}
              </div>
            </section>
            <section className="container">
              <div className="availability">
                <div className="icon-box amber">
                  <Download />
                </div>
                <div>
                  <h2>Senario est disponible pour Windows.</h2>
                  <p>
                    Installez la bêta sur Windows 10 ou 11 en 64 bits. Les
                    nouvelles versions signées sont ensuite téléchargées et
                    installées automatiquement.
                  </p>
                </div>
                <a className="button primary" href="/telecharger">
                  Télécharger <ArrowRight size={16} />
                </a>
              </div>
            </section>
          </>
        )}
        {route === '/telecharger' && (
          <section className="container page download-page">
            {title(
              'APPLICATION WINDOWS',
              'Télécharger Senario.',
              'Installez la bêta sur Windows 10 ou 11. Vos fichiers .scenario restent enregistrés sur votre ordinateur.',
            )}
            <div className="download-grid">
              <article className="panel download-card">
                <div className="icon-box">
                  <MonitorDown />
                </div>
                <div>
                  <p className="eyebrow">WINDOWS 64 BITS</p>
                  <h2>Senario 0.1.12</h2>
                  <p>
                    Écrivez et enregistrez vos fichiers locaux sans créer de compte.
                    La connexion dans l’application active ensuite les droits Auteur
                    ou Studio et autorise automatiquement cet appareil.
                    Programme d’installation .exe pour Windows 10 et Windows 11.
                  </p>
                </div>
                <a
                  className="button primary"
                  href={windowsDownloadUrl}
                  download
                >
                  Télécharger pour Windows <Download size={17} />
                </a>
                <dl className="download-facts">
                  <div>
                    <dt>Version</dt>
                    <dd>0.1.12 · bêta</dd>
                  </div>
                  <div>
                    <dt>Format</dt>
                    <dd>Installateur .exe</dd>
                  </div>
                  <div>
                    <dt>Mises à jour</dt>
                    <dd>Automatiques et signées</dd>
                  </div>
                  <div>
                    <dt>Paiement</dt>
                    <dd>Sécurisé par Stripe</dd>
                  </div>
                </dl>
              </article>
              <article className="installation-steps">
                <p className="eyebrow">INSTALLATION</p>
                <h2>Trois étapes.</h2>
                <ol>
                  <li>
                    <span>1</span>
                    <div>
                      <strong>Téléchargez Scenario-Setup.exe</strong>
                      <p>Le fichier vient de la page de publication Senario.</p>
                    </div>
                  </li>
                  <li>
                    <span>2</span>
                    <div>
                      <strong>Ouvrez le fichier</strong>
                      <p>
                        Pendant la bêta, Windows peut afficher « Éditeur
                        inconnu ». Vérifiez que le fichier s’appelle bien
                        Scenario-Setup.exe avant de continuer.
                      </p>
                    </div>
                  </li>
                  <li>
                    <span>3</span>
                    <div>
                      <strong>Lancez Senario</strong>
                      <p>
                        Les mises à jour sont vérifiées au démarrage. Une mise à
                        jour attend que votre document soit enregistré avant de
                        s’installer.
                      </p>
                    </div>
                  </li>
                </ol>
                <div className="update-note">
                  <RefreshCw size={18} />
                  <p>
                    Une coupure Internet n’empêche pas d’écrire dans un fichier
                    local.
                  </p>
                </div>
              </article>
            </div>
            <div className="inline-offers">
              <span>
                Choisissez les fonctions cloud et collaboratives dont vous avez
                besoin.
              </span>
              <a className="button secondary" href="/offres">
                Voir les offres <ArrowRight size={16} />
              </a>
            </div>
          </section>
        )}
        {route === '/offres' && (
          <div className="container page offers-page" id="offres">
            {title(
              'OFFRES',
              'Comparez les trois offres.',
              'Gratuite, Auteur ou Studio. Comparez les fonctionnalités et choisissez votre formule.',
            )}
            <div className="pricing-controls">
              {billingSwitch()}
              <span>
                En annuel, le prix affiché correspond au montant annuel divisé
                par 12.
              </span>
            </div>
            <div className="offer-grid">{offers()}</div>
            {!plans.length && (
              <p className="notice">
                {catalogError ||
                  (!account
                    ? 'Catalogue momentanément indisponible.'
                    : 'Chargement des offres…')}
              </p>
            )}
            <p className="test-note">
              <LockKeyhole size={15} />
              {catalogueInTestMode
                ? ' Les abonnements sont en mode test. Aucun paiement réel.'
                : ' Paiement sécurisé par Stripe. Les fonctionnalités sont activées après confirmation.'}
            </p>
            {message && <output className="notice">{message}</output>}
            <section className="faq">
              <div>
                <p className="eyebrow">FAQ</p>
                <h2>Avant de commencer.</h2>
                <p>
                  Une autre question ?<br />
                  <a href="/contact">
                    Écrivez-nous <ArrowUpRight size={14} />
                  </a>
                </p>
              </div>
              <div>
                {faq.map(([q, a]) => (
                  <details key={q}>
                    <summary>
                      {q}
                      <ChevronRight size={18} />
                    </summary>
                    <p>{a}</p>
                  </details>
                ))}
              </div>
            </section>
          </div>
        )}
        {(route === '/connexion' || route === '/reinitialisation') && (
          <section className="container page auth-layout">
            <div className="auth-intro">
              {title(
                route === '/connexion'
                  ? 'VOTRE ESPACE SENARIO'
                  : 'ACCÈS AU COMPTE',
                route === '/connexion'
                  ? 'Connectez-vous à senario.'
                  : recoveryLink
                    ? 'Un nouveau mot de passe.'
                    : 'Mot de passe oublié ?',
                route === '/connexion'
                  ? 'La connexion sert à activer les fonctions Auteur ou Studio. L’écriture locale reste accessible sans compte dans l’application.'
                  : recoveryLink
                    ? 'Choisissez votre mot de passe, puis confirmez-le.'
                    : 'Indiquez l’adresse de votre compte. Nous vous enverrons un lien pour choisir un nouveau mot de passe.',
              )}
              <div className="auth-footnote">
                <LockKeyhole size={18} />
                <p>
                  Une actualisation de la page demande une nouvelle connexion.
                </p>
              </div>
            </div>
            {view && route === '/connexion' ? (
              <div className="auth-card">
                <h2>Vous êtes connecté.</h2>
                <p>{view.me.account.email}</p>
                <a className="button primary" href="/compte">
                  Ouvrir mon compte <ArrowRight size={16} />
                </a>
              </div>
            ) : (
              authForm()
            )}
          </section>
        )}
        {route === '/compte' && (
          <section className="container page account-page">
            {title(
              'MON COMPTE',
              view
                ? `Bonjour${view.me.account.displayName ? `, ${view.me.account.displayName}` : ''}.`
                : 'Votre compte senario.',
              view
                ? 'Retrouvez vos informations et gérez votre abonnement.'
                : 'Connectez-vous pour consulter vos informations et votre abonnement.',
            )}
            {view ? (
              <>
                <div className="account-grid">
                  <article className="panel">
                    <div className="panel-heading">
                      <Users size={20} />
                      <h2>Vos informations</h2>
                    </div>
                    <dl>
                      <dt>Nom</dt>
                      <dd>{view.me.account.displayName ?? 'Non renseigné'}</dd>
                      <dt>Adresse e-mail</dt>
                      <dd>{view.me.account.email}</dd>
                    </dl>
                    <a className="text-link" href="/reinitialisation">
                      Changer mon mot de passe <ArrowUpRight size={14} />
                    </a>
                  </article>
                  <article className="panel">
                    <div className="panel-heading">
                      <FileText size={20} />
                      <h2>Votre abonnement</h2>
                    </div>
                    <p className="subscription-name">
                      {view.billing.billing.offerDisplayName ??
                        'Aucun abonnement'}
                    </p>
                    <span className="badge">
                      {
                        (
                          {
                            active: 'Actif',
                            none: 'Sans abonnement',
                            trialing: 'En essai',
                            past_due: 'À régulariser',
                            paused: 'En pause',
                            canceled: 'Résilié',
                            expired: 'Expiré',
                          } as const
                        )[view.billing.billing.status]
                      }
                    </span>
                    <p className="muted">
                      Abonnement de test · Aucun prélèvement réel
                    </p>
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() =>
                        void perform(async () =>
                          location.assign(
                            await account!.portal(`${location.origin}/compte`),
                          ),
                        )
                      }
                    >
                      Gérer l’abonnement test <ArrowUpRight size={16} />
                    </button>
                  </article>
                </div>
                <div className="account-actions">
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        setView(await account!.account());
                        setMessage('Votre compte est à jour.');
                      })
                    }
                  >
                    <History size={16} /> Actualiser mon compte
                  </button>
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        setView(null);
                        navigate('/connexion', true);
                        await account!.signOut();
                        setMessage('Vous êtes déconnecté.');
                      })
                    }
                  >
                    Se déconnecter
                  </button>
                </div>
              </>
            ) : (
              <div className="panel empty-account">
                <LockKeyhole size={30} />
                <h2>Connectez-vous pour continuer.</h2>
                <p>Utilisez l’adresse et le mot de passe de votre compte.</p>
                <a href="/connexion" className="button primary">
                  Se connecter <ArrowRight size={16} />
                </a>
              </div>
            )}
            {notice && <output className="notice">{notice}</output>}
            <div className="inline-offers">
              <span>Envie de comparer les formules ?</span>
              <a className="button secondary" href="/offres">
                Voir les offres <ArrowRight size={16} />
              </a>
            </div>
          </section>
        )}
        {route === '/contact' && (
          <section className="container page contact-page">
            {title(
              'CONTACT',
              'Contactez l’équipe.',
              'Un problème avec votre compte, une question sur un projet ou une remarque sur la bêta ? Écrivez-nous.',
            )}
            <div className="contact-grid">
              <article className="panel contact-card">
                <div className="icon-box">
                  <Mail />
                </div>
                <h2>Le support senario</h2>
                <a
                  className="contact-address"
                  href="mailto:support@senario.app"
                >
                  support@senario.app
                </a>
                <p>
                  Nous vous répondrons à l’adresse utilisée pour nous écrire.
                </p>
                <a
                  className="button primary"
                  href="mailto:support@senario.app?subject=Question%20sur%20Senario"
                >
                  Écrire un e-mail <ArrowUpRight size={16} />
                </a>
              </article>
              <article className="contact-instructions">
                <h2>Pour signaler un problème</h2>
                <ol>
                  <li>Décrivez ce que vous vouliez faire.</li>
                  <li>Indiquez ce qui s’est passé et le message affiché.</li>
                  <li>Ajoutez la version de senario et votre système.</li>
                </ol>
                <p>
                  Ne joignez pas de mot de passe ni de scénario confidentiel.
                  Masquez les informations personnelles sur vos captures.
                </p>
                <a className="text-link" href="/offres">
                  Consulter les questions fréquentes <ArrowRight size={15} />
                </a>
              </article>
            </div>
            <div className="contact-bottom">
              <h2>Vos données et votre compte</h2>
              <p>
                Pour demander l’accès, l’export ou la suppression de vos
                données, utilisez cette même adresse. La suppression du compte
                n’est pas encore disponible en libre-service.
              </p>
              <a className="text-link" href="/confidentialite">
                Lire les informations de confidentialité{' '}
                <ArrowUpRight size={15} />
              </a>
            </div>
          </section>
        )}
        {['/confidentialite', '/conditions', '/mentions'].includes(route) && (
          <div className="container page legal-page">
            {title(
              'INFORMATIONS',
              routes[route],
              'Informations applicables à la bêta.',
            )}
            <InformationPages page={route.slice(1)} />
          </div>
        )}
        {!(route in routes) && (
          <section className="container page">
            {title(
              '404',
              'Cette page n’existe pas.',
              'Vérifiez l’adresse ou revenez à l’accueil.',
            )}
            <a className="button primary" href="/">
              Revenir à l’accueil <ArrowRight size={16} />
            </a>
          </section>
        )}
      </main>
      <footer className="footer">
        <div className="container footer-main">
          <a className="brand" href="/">
            <img src="/scenario-logo.png" alt="" />
            senario
          </a>
          <p>la meilleure page blanche</p>
          <a href="/offres">
            Voir les offres <ArrowUpRight size={14} />
          </a>
          <a href="/telecharger">Télécharger</a>
          <a href="/contact">Contact</a>
        </div>
        <div className="container footer-bottom">
          <span>© {new Date().getFullYear()} senario · Bêta</span>
          <nav aria-label="Informations légales">
            <a href="/confidentialite">Confidentialité</a>
            <a href="/conditions">Conditions</a>
            <a href="/mentions">Mentions légales</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
