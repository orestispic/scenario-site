# Site multipage — charte Senario

## Périmètre

Refonte du site commercial sur `codex/commercial-platform`, à partir de la planche
utilisateur `Senario-UI-Charte-4K.png`. L'application desktop fera l'objet d'une mise
à jour séparée. Slogan exact : « la meilleure page blanche ».

Pages : `/` (fonctionnalités), `/offres` (trois offres et FAQ), `/compte`,
`/connexion` (connexion et inscription), `/reinitialisation` (demande de lien ou
nouveau mot de passe selon le lien reçu), `/contact`. Les informations légales sont
également isolées sur `/confidentialite`, `/conditions` et `/mentions`.

Les liens d'offres sont communs à chaque page, y compris un bouton visible en
navigation mobile. Le contact ouvre la messagerie vers `support@senario.app` et
ne prétend pas avoir envoyé un message depuis le site.

## Direction artistique

Fond `#080B10`, panneau `#11161E`, flottant `#181F29`, survol `#1B2430`, sélection
`#132B44`, bordure `#27313E`, texte `#EDF2F7`, texte secondaire `#9AA7B7`.
Actions bleues `#2A86E6`, état pressé `#1968B9`, accent ambre `#E5B33E`.
Rayons 6–8 px, icônes Lucide avec trait 1,6 px, focus bleu visible et mouvement réduit.
Inter et Courier Prime sont auto-hébergées dans `public/fonts` avec leurs licences
SIL OFL. Aucune requête Google Fonts n'est nécessaire chez le visiteur.

L'aperçu de scénario est un exemple HTML identifié comme tel, et non une capture
de la version desktop actuelle. Le contenu d'exemple n'est pas éditable.

## Navigation et comptes

Les URL sont distinctes, servies directement par les réécritures Vercel. La
navigation interne utilise History et conserve la session en mémoire entre pages.
Retour/précédent est pris en charge. Une actualisation complète demande toujours
une connexion conformément au stockage de session existant.

Les anciens liens `#offres`, `#compte`, `#projets` et légaux continuent de fonctionner.
Les liens de confirmation/récupération sont consommés par `takeEmailLink` avant
affichage et chargement du catalogue, puis remplacés par le chemin adapté. Les
contrats et l'adaptateur BrowserAccount sont inchangés. Les nouveaux mots de passe
doivent être saisis deux fois ; une différence ne déclenche aucun appel.

Catalogue, prix, fonctionnalités et droits continuent de provenir du serveur.
L'annuel est sélectionné initialement ; son montant mensuel est calculé par
division par 12 et l'économie est comparée aux douze mensualités de même devise.
Aucune nouvelle offre ni nouvelle règle commerciale. Paiements test exclusivement.

## Validation locale

- Typecheck et build bêta réussis.
- Lint ciblé et recherche de secrets réussis.
- 17 tests existants navigateur/contrats, confirmation et migrations réussis.
- E2E local intercepté : pages séparées, navigation arrière en conservant la session,
  offres mensuelles/annuelles, connexion/compte/déconnexion, demande de récupération,
  différence de mots de passe refusée, récupération et confirmation consommées une
  seule fois, redirection Checkout simulée.
- Les neuf chemins testés directement à largeur mobile retournent 200, affichent
  un seul h1 et n'ont pas de débordement horizontal ; menu et accès aux offres testés.
- Captures desktop accueil/offres et mobile de chaque page inspectées dans `outputs`.

Commandes : `npm.cmd run typecheck`, `npm.cmd run build:beta`,
`npm.cmd exec oxlint -- src/beta.tsx src/information.tsx scripts/phase11-site-e2e.mjs`,
`node --experimental-transform-types --test tests/phase11-browser.test.ts tests/phase11-readiness.test.ts tests/phase12-email.test.ts`,
`npm.cmd run test:security`, `node --experimental-transform-types scripts/phase11-site-e2e.mjs`
(origine locale `http://127.0.0.1:4175`), `git diff --check`.

L'E2E local intercepte les services : il ne constitue pas une validation Supabase
ou Stripe réelle. Le résultat du contrôle hébergé après déploiement est consigné
séparément. Noindex, absence de téléchargement public et limites de bêta conservés.

## Publication et contrôle réel — 13 septembre 2026

Commit livré : `9d96f5c`. Déploiement Vercel production
`dpl_EgEuaKxeFkiZwXyM7AVHTKUect3x`, statut READY, alias `https://senario.app`.
La commande `npx.cmd --yes vercel@latest deploy --prod --yes --no-color` a reconstruit
la version avec les variables publiques existantes de production.

E2E hébergé réussi (`SCENARIO_TEST_SITE_URL=https://senario.app`, option `--hosted`) :
catalogue réel et bascule annuel/mensuel, connexion du compte Owner synthétique via
Supabase, compte Cloudflare, navigation offres/retour conservant la session,
déconnexion, neuf pages accessibles directement, menu mobile, absence de
débordement horizontal et de jetons dans le stockage navigateur. Les prix réels
du catalogue de test sont conservés : Auteur annuel affiché à 7,33 €/mois.
Les captures publiques ont été relues. Aucun e-mail, compte ni paiement créé.
Confirmation et récupération ont été testées localement avec interception, sans
renvoyer d'e-mail réel lors de cette refonte. Aucun déploiement Worker ni migration.
