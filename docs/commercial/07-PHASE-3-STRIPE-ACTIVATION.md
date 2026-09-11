# Phase 3 — Stripe test, abonnements et clés d’activation

## État livré

Le contrat public `2026-09-v3` complète les contrats v1/v2 sans les modifier. Les routes `/v2` sont authentifiées, sauf le webhook Stripe qui exige la signature `Stripe-Signature` sur le corps brut exact.

| Route | Rôle |
| --- | --- |
| `GET /v2/billing` | Offres visibles et état de facturation issus du serveur |
| `POST /v2/checkout/sessions` | Checkout Stripe test à partir d’un `selectionId` validé côté serveur |
| `POST /v2/billing/portal-sessions` | Portail client Stripe test pour le customer déjà lié |
| `POST /v2/stripe/webhook` | Signature HMAC, fenêtre temporelle bornée, idempotence et projection ordonnée |
| `GET /v2/activation-keys/status` | Activations du compte courant |
| `POST /v2/activation-keys/redeem` | Empreinte de clé, snapshot de droits et appareil, atomiquement |
| `POST /v2/activation-keys/revoke` | Révocation réservée à un profil admin lu en base |

Le point d’entrée de production n’importe ni catalogue, ni passerelle, ni identités locales. Il refuse toute clé Stripe qui ne commence pas par `sk_test_`. Le navigateur ne reçoit jamais `provider_price_id`, clé secrète, secret webhook, pepper ou clé brute enregistrée.

## Modèle de données

La migration append-only `20260912000000_stripe_billing_activation.sql` ajoute clients Stripe, sessions Checkout, événements webhook, factures utiles et redemptions. Elle complète les abonnements avec l’horodatage du dernier événement fournisseur et les snapshots avec un identifiant causal unique.

`stripe_webhook_events.provider_event_id` rend le traitement idempotent. Un événement ancien est conservé dans l’historique mais ne remplace pas une projection plus récente. Chaque abonnement référence la ligne `prices` historique, elle-même liée à une version de configuration. Un snapshot copie les droits, quotas, limite d’appareils et tolérance hors ligne au moment de l’événement valide : une modification future du catalogue ne réécrit donc pas les droits déjà achetés.

Les clés sont générées avec 192 bits aléatoires. Seuls leur HMAC-SHA-256 avec pepper serveur et leurs six derniers caractères sont conservés. La clé brute n’est renvoyée qu’à la création locale. Les écritures commerciales et les RPC restent `service_role`; les lectures directes éventuellement accordées sont limitées par RLS au propriétaire.

## Démarrage local sans compte externe

Dans un premier terminal :

```powershell
npm.cmd run start:api:local
```

Dans un second terminal :

```powershell
$env:NEXT_PUBLIC_SCENARIO_AUTH_MODE='local-test'
$env:NEXT_PUBLIC_SCENARIO_API_BASE_URL='http://127.0.0.1:8787'
npm.cmd run dev
```

Le catalogue local contient quatre sélections serveur : Auteur IA mensuel/annuel et Studio mensuel/annuel. Leurs montants, limites et droits sont absents du client et servis uniquement par le Worker local. Choisir un profil local, puis lire `offers[].selectionId` dans `GET /v2/billing` ou dans l’interface.

Pour générer une clé et l’afficher une seule fois :

```powershell
npm.cmd run activation-key:local:create -- <selection-id> 1 2027-01-01T00:00:00Z
```

Pour la révoquer avec l’identifiant affiché à la création :

```powershell
npm.cmd run activation-key:local:revoke -- <key-id>
```

Ces outils parlent uniquement au point d’entrée `local-test`. Leur garde locale, leurs fixtures et leurs valeurs ne sont pas dans le graphe d’imports du Worker de production.

## Fixtures Stripe et tests

Les fixtures construisent le JSON exact de l’événement, puis calculent `HMAC-SHA-256(timestamp + "." + rawBody)`. Les tests couvrent signature valide/invalide, corps modifié, délai dépassé, événement rejoué, ordre désynchronisé, changement d’offre, renouvellement, paiement échoué, annulation, expiration et conservation d’un snapshot acheté. Un retour Checkout simulé ne modifie aucun droit.

Le mode local utilise une passerelle Checkout simulée. Pour reproduire les transitions, exécuter `npm.cmd run test:api`; aucun appel Stripe ou Supabase n’est effectué.

## Connexion future à Stripe test et Supabase

1. Créer les quatre Prices Stripe test, puis enregistrer leurs identifiants `price_...` uniquement dans les lignes serveur `prices` reliées aux versions de configuration publiées.
2. Appliquer les trois migrations Supabase dans l’ordre sur un projet isolé et vérifier les RPC/RLS avec des JWT propriétaire, autre utilisateur et service-role.
3. Fournir au Worker via le gestionnaire de secrets `STRIPE_SECRET_KEY=sk_test_...`, `STRIPE_WEBHOOK_SECRET=whsec_...`, `ACTIVATION_KEY_PEPPER` et les secrets Supabase de phase 2.
4. Configurer le webhook test vers `/v2/stripe/webhook`, puis rejouer chaque type d’événement pris en charge. Ne jamais utiliser la page de succès comme preuve d’achat.
5. Remplacer le rate limit mémoire par un stockage distribué avant toute exposition partagée.

Variables attendues : `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_WEBHOOK_TOLERANCE_SECONDS`, `ACTIVATION_KEY_PEPPER`, plus les variables de phase 2. `.env.example` ne contient que des placeholders; aucun `.env` réel n’est créé.

## Fonctionnel, simulé et bloqué

- Fonctionnel localement : contrats, routes, validation stricte, signatures, idempotence, transitions, snapshots, clés, limites, audit en dépôt local, interfaces et tests.
- Simulé : identités, catalogue de test, stockage mémoire, Checkout/portail et fixtures webhook du Worker local.
- Prêt mais non exécuté : appels REST Stripe test, accès service-role Supabase et migration PostgreSQL réelle.
- Bloqué volontairement : paiement Stripe test réel, portail Stripe réel et tests RLS sur Supabase local, faute d’identifiants/CLI déjà fournis. Aucun compte n’a été créé, aucun déploiement n’a été tenté.

## Prompt pour la phase 4

Réalise uniquement la phase 4 du projet commercial Scénario : durcissement préproduction, stockage sécurisé des sessions, rate limiting distribué, observabilité et validation bout en bout sur les environnements de test existants. Travaille exclusivement dans les worktrees commerciaux `scenario-app-commercial` sur `codex/commercial-v1` et `scenario-site-commercial` sur `codex/commercial-platform`. Ne modifie jamais les dépôts source, leurs branches `main` ou le dossier `mac`. Ne pousse, ne déploie et ne publie rien. N’utilise aucun paiement réel et ne crée aucun compte externe. Si des identifiants Supabase/Stripe test ne sont pas déjà fournis, conserve des adaptateurs locaux strictement isolés et documente le blocage.

Lis d’abord toute la documentation et tous les contrats des phases 0 à 3, notamment `07-PHASE-3-STRIPE-ACTIVATION.md`, `contracts-v3.ts`, les Workers et les migrations Supabase. Préserve les contrats publics existants; toute évolution doit être versionnée et documentée. Place le refresh token de l’application Tauri dans un coffre-fort système injectable, garde l’access token court uniquement en mémoire, traite rotation, révocation, expiration et déconnexion, et ne stocke aucun jeton dans `localStorage`. Remplace le rate limiting mémoire des routes sensibles par une abstraction distribuée compatible Cloudflare, avec clés non sensibles, fenêtres bornées et comportement sûr en cas de panne. Ajoute des journaux structurés sans secret ni donnée de paiement, corrélation par `request_id`, métriques utiles et procédures d’alerte/rejeu des webhooks sans double attribution.

Prépare une configuration préproduction séparée et vérifie que seuls des identifiants Stripe test sont acceptés. Ajoute des tests bout en bout locaux couvrant inscription/connexion, Checkout test simulé, webhook vérifié, droits signés, activation/révocation d’appareil et de clé, renouvellement de session, mode hors ligne, récupération après panne et refus d’élévation de privilèges. Si Supabase local, Stripe CLI ou des comptes test sont disponibles, exécute aussi les validations réelles isolées; sinon fournis les commandes exactes et fixtures déterministes. Ajoute des contrôles de migrations append-only, RLS, CORS/CSRF, replay, concurrence et recherche de secrets. Vérifie tests, builds, typechecks, lint ciblé et compilation Worker à blanc, corrige tout problème introduit, documente ce qui est fonctionnel/simulé/bloqué, puis committe localement chaque worktree modifié sans pousser.

Dans la réponse finale, donne les commits créés, résume les garanties obtenues, distingue les validations locales des validations externes encore attendues, liste toutes les commandes de validation exécutées et termine par une section « Prompt pour la phase 5 » contenant le prompt complet prêt à copier.
