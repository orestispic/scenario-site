# Phase 4 — durcissement local et préproduction

## Périmètre livré

La numérotation de cette livraison suit les demandes explicites : phase 3 = Stripe test et clés, phase 4 = sécurité des sessions, limitation distribuée, observabilité et validations. Le tableau initial de phase 0 est historique. Aucun compte, secret réel, paiement, push ni déploiement n’est créé.

Les contrats v1/v2/v3 et les migrations précédentes restent inchangés. Le contrat miroir `2026-09-v4` ajoute `GET /v3/entitlements` : la charge ES256 inclut `snapshotJson`, l’intégralité exacte du snapshot, en plus du compte, des identifiants et dates. Le client v4 vérifie ces champs avant chaque lecture hors ligne. Les anciens caches ne sont pas promus en cache v4. Les routes historiques restent compatibles ; aucun nouveau client ne doit utiliser le cache v2 comme autorité de droits, car sa signature historique ne liait pas le contenu des droits.

## Sessions et coffre-fort

L’application utilise `keyring` 3.6.3 avec les fonctionnalités natives Windows/macOS. Le refresh token est placé dans une entrée système distincte par couple API/fournisseur auth ; l’access token n’existe qu’en mémoire. Une seconde entrée système conserve la clé publique et l’identité de confiance nécessaires pour vérifier le cache lors d’un redémarrage hors ligne. Aucun jeton ne va dans localStorage/sessionStorage. Le navigateur de développement reste non persistant ; une panne de coffre-fort natif ne déclenche pas de repli navigateur.

La rotation est sérialisée et partagée entre les requêtes concurrentes. Un refresh rejeté efface la session, une panne réseau conserve le refresh pour réessayer, une erreur de persistance refuse l’access token et tente sa révocation. La déconnexion invalide immédiatement l’état mémoire puis efface le coffre-fort ; une rotation en cours ne peut ressusciter la session. En cas d’échec réseau du logout, le message reste une erreur et la révocation distante n’est pas déclarée réussie.

Les JWT Supabase sont vérifiés via JWKS avec cache borné, rafraîchissement à rotation et une seule requête parallèle. Une panne JWKS retourne 503 et non une fausse invalidation de session. Limite explicite : Supabase peut laisser un JWT d’accès déjà émis valide jusqu’à `exp` après logout ; la durée courte doit être configurée sur le projet test. Le simulateur local révoque immédiatement ses jetons opaques. L’inscription/connexion réelle reste chez Supabase Auth et dépend également de ses protections anti-abus ; le limiteur Worker ne remplace pas celles du fournisseur.

## Rate limiting distribué

`DistributedRateLimiter` remplace le limiteur mémoire dans le point d’entrée serveur. Chaque couple sujet/route aboutit, après HMAC avec `RATE_LIMIT_KEY_PEPPER`, à un Durable Object différent. Le stockage ne reçoit ni adresse IP, ni email, ni identifiant de profil, ni token. Le compteur et son échéance sont modifiés transactionnellement ; une alarme supprime le bucket expiré. Les fenêtres sont bornées à 1 seconde–1 heure et les compteurs sont saturés à la limite.

Toutes les routes connues, y compris configuration, webhook et requêtes sans session, passent par un contrôle d’entrée. Les routes authentifiées ajoutent un contrôle par profil ; les tentatives de clé gardent leur audit pré-authentification. Une indisponibilité/timeout/réponse invalide du stockage retourne 503 sans exécuter l’opération ; une limite atteinte retourne 429. Le point d’entrée local conserve son simulateur mémoire isolé. Les OPTIONS ne modifient aucun état et les chemins inconnus ne créent aucun bucket.

## Préproduction séparée

`wrangler.preproduction.toml` configure un Worker distinct, `staging`, sans workers.dev, sans URL preview, sans route publique, avec namespace Durable Object et observabilité. Ses domaines `.invalid` sont des placeholders. Le nom de classe/migration Durable Object est propre à ce Worker. `wrangler.api.toml` possède aussi le binding nécessaire à son entrée serveur ; les ressources ne sont pas créées lors des compilations à blanc.

Configurer ultérieurement, dans le gestionnaire de secrets de cet environnement seulement : URL/clé Supabase test, service role, peppers séparés, clés ES256, `sk_test_...` et `whsec_...`. La passerelle Stripe vérifie elle-même le préfixe test, même lorsqu’elle est injectée directement. La tolérance webhook doit être un entier de 1 à 300 secondes. Les Prices sont fournis par la base et ne sont jamais choisis librement par le client. La présence d’un préfixe test ne prouve pas à elle seule qu’un projet Supabase est isolé : vérifier son identité avant tout futur essai externe.

L’overlay Tauri `tauri.preproduction.conf.json` sépare l’identifiant application et sa CSP. Remplacer uniquement ses deux domaines HTTPS placeholders par les domaines test approuvés, en cohérence avec VITE. Le devCsp permet le Worker loopback. Commande future de lancement : `npm.cmd run tauri -- dev --config src-tauri/tauri.preproduction.conf.json`. Aucun installateur ni publication n’est produit ici.

## SQL, révocation et concurrence

La migration `20260913000000_preproduction_hardening.sql` est ajoutée après les trois précédentes. Elle enveloppe l’ancienne RPC Stripe avec validation `livemode=false`, cohérence id/type, empreinte et verrou transactionnel par customer. L’ancienne RPC n’est plus appelable directement par service_role. Les factures anciennes ne remplacent pas une projection récente. Les snapshots restent immuables ; la lecture effective exclut les clés révoquées/expirées, et l’activation d’appareil utilise cette lecture. La redemption écrit son lien de snapshot avant l’activation d’appareil dans la même transaction, ce qui permet un rollback intégral à la limite. Les colonnes de jetons fournisseur Instagram ne sont plus lisibles par authenticated.

Les tests statiques figent les SHA-256 des migrations 0–3 (normalisation CRLF/LF seulement). Le fichier `supabase/tests/phase4_rls.sql` prépare dix assertions PostgreSQL/pgTAP, dont lecture propriétaire/croisée, interdiction d’élévation et privilèges RPC. Il n’a pas été exécuté : Supabase CLI et Docker sont absents. Les tests locaux de concurrence ne constituent pas une preuve d’exécution PostgreSQL des migrations.

## Observabilité et procédure d’incident

Les logs structurés contiennent uniquement : `event`, `request_id` généré serveur, route issue d’une liste fermée, méthode bornée, status, durée, outcome et résultat webhook. Les query strings, corps, cookies, headers d’auth, profils, clés d’activation, identifiants Stripe et données de paiement ne sont jamais envoyés à ce sink. Une panne du sink ne transforme pas une mutation réussie en échec rejouable. Un échec d’audit est signalé par `audit.unavailable` et `request_id` seulement.

Métriques à agréger depuis les logs, avec dimensions route/méthode/status et sans `request_id` comme label : nombre de requêtes, latences p50/p95, ratios 401/403/429/5xx, webhook processed/replayed/failed. Configuration d’alertes suggérée pour le test partagé : tout `audit.unavailable`; 5xx > 1 % sur 5 minutes avec au moins 100 requêtes ; 3 échecs webhook consécutifs ; hausse anormale de 429. Ces seuils opérationnels sont des valeurs serveur proposées, à ajuster après mesure. Aucun dashboard ou abonnement d’alerte externe n’a été créé.

En incident webhook :

1. Relever les `request_id`, le type d’erreur et le dernier instant de succès ; consulter l’historique Stripe test dans l’outil autorisé, jamais copier les corps dans les logs.
2. Corriger la configuration ou la dépendance en panne avant toute rediffusion. Le 2xx est renvoyé seulement après la transaction métier.
3. Rediffuser depuis Stripe test l’événement original, avec son même `event.id` et une nouvelle signature de livraison. Ne jamais modifier l’identifiant causal ni effacer l’historique pour forcer un retraitement.
4. Vérifier un seul snapshot `source_event_id`, un état métier inchangé au second passage et `webhook=replayed`. Une transaction SQL échouée n’enregistre pas l’événement comme terminé ; elle peut être rejouée.
5. Si le corps d’un identifiant déjà enregistré diffère, investiguer `event_payload_mismatch`, sans contourner le refus. Lors d’une livraison ancienne, conserver l’historique mais ne pas appliquer une projection plus vieille.

## Reproduction locale

Dans `scenario-site-commercial` :

```powershell
npm.cmd run test:api
npm.cmd run test:security
node scripts/security-check.mjs --app
npm.cmd run typecheck
npm.cmd run build
node scripts/check-phase4-style.mjs
node scripts/check-phase4-style.mjs --app
npm.cmd exec -- wrangler deploy --dry-run --config wrangler.preproduction.toml --outdir .wrangler/phase4-preproduction
node scripts/test-rate-limit-runtime.mjs
npm.cmd exec -- wrangler deploy --dry-run --config wrangler.local-test.toml --outdir .wrangler/phase4-local
node scripts/test-local-runtime.mjs
git diff --check
```

Les deux commandes Wrangler portent obligatoirement `--dry-run`. Les scripts Miniflare démarrent et ferment leur runtime local ; ils n’appellent aucun fournisseur et n’utilisent aucune donnée réelle. `test-local-runtime.mjs` couvre inscription/connexion, Checkout simulé, webhook signé/replay, droits signés, appareil/clé, rotation et logout. `phase4-e2e.test.ts` ajoute expirations, corps bornés, CORS/CSRF, refus d’élévation, concurrence et confidentialité des métriques. Le contrat auth du simulateur est limité à `/_local/auth/v1/*` et aux emails `example.invalid` ; il n’est jamais dans le bundle serveur.

Dans `scenario-app-commercial` :

```powershell
npm.cmd test -- --run
npm.cmd run build
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml native_vault_roundtrip -- --ignored
rustfmt --edition 2021 --check src-tauri/src/session_vault.rs
git diff --check
```

Le test natif demande une session Windows réelle : le sandbox sans session interactive renvoie `NoStorageAccess(1312)`. Le test crée puis supprime son entrée synthétique uniquement. Les caches testent contenu falsifié, autre compte, expiration exacte, horloge reculée et récupération. Les adaptateurs de coffre-fort testent séparation des entrées, redémarrage et refus sans repli non sécurisé.

Lint/format ciblés : exécuter les binaires Oxlint/Oxfmt déjà installés dans le site sur les fichiers TypeScript de phase 4 (les deux worktrees), puis `oxfmt --check`. `cargo fmt --check` global signale des différences de format préexistantes dans `lib.rs` ; seul `session_vault.rs` est formaté. Le script Sites `build-site.mjs` dépend de la version locale du plugin ; si le wrapper ne résout pas npm, utiliser le script existant `npm.cmd run build` sans changer le projet.

## Validations externes à exécuter plus tard

Outils détectés : Cargo disponible ; Supabase CLI, Docker et Stripe CLI absents ; aucune variable de credentials Supabase/Stripe ni fichier `.env` réel fourni. Les validations externes restent bloquées. Le Keychain macOS doit être testé sur macOS ; le dossier `mac` n’est pas touché.

Sur une installation Docker/Supabase locale existante et jetable, depuis ce worktree, sans projet distant lié :

```powershell
supabase init
supabase start
supabase db reset --local
supabase test db
```

`supabase init` est à omettre si `supabase/config.toml` existe déjà. `db reset --local` détruit uniquement la base locale de test : ne pas exécuter sur un environnement contenant des données à conserver. Vérifier la sortie pgTAP, puis les parcours avec deux utilisateurs synthétiques et les configurations/offres de test explicitement provisionnées côté serveur. Aucun `db push` distant n’est autorisé par cette phase.

Une fois Stripe CLI authentifiée sur un compte test déjà fourni :

```powershell
stripe listen --forward-to http://127.0.0.1:8787/v2/stripe/webhook
stripe events resend evt_REPLACE_WITH_EXISTING_TEST_EVENT --webhook-endpoint we_REPLACE_WITH_EXISTING_TEST_ENDPOINT
```

Utiliser l’entrée Supabase/Stripe test réelle, pas `local-test`, avec des secrets fournis hors dépôt. Les identifiants ci-dessus doivent être remplacés par un événement et endpoint test déjà existants ; ces commandes ne sont pas exécutées ici. Vérifier le prix/customer test, le consentement à l’essai et le seul snapshot causal avant et après rediffusion. Les fixtures génériques `stripe trigger` ne contiennent pas les liens Scénario nécessaires ; utiliser le Checkout test créé par l’API.

## Limites à conserver visibles

La configuration désactive les logs automatiques d’invocation Cloudflare (`invocation_logs=false`) pour éviter d’y copier les URLs brutes ; les journaux applicatifs restent structurés et filtrés. Les routes de gestion du compte restent accessibles sans appareil actif ; les futures routes IA/cloud devront explicitement vérifier l’appareil. Le cache signé n’est pas une preuve d’activation réseau d’un appareil.

Bilan local : 45 tests Vitest dans 13 fichiers, 31 tests site/API, builds des deux clients, compilation Rust Windows, smoke natif coffre-fort, deux parcours workerd (limiteur SQLite et E2E métier), lint/format ciblés, recherche de secrets dans les deux worktrees et `git diff --check`. Les contrôles des sources confirment les HEAD main `dbf1bf1692a5096fd92887ce551cacaa6e818c39` et `bd0f74245c513c150474dc9551a7cf0236ebde6f` inchangés.

- Réels et locaux : compilation Windows, coffre-fort Windows, signatures cryptographiques, limites transactionnelles sous workerd/SQLite, builds et tests.
- Simulés : utilisateurs, paiements, catalogue et base métier du parcours E2E local. Le simulateur ne reproduit pas toutes les politiques Supabase ni la conservation de plusieurs achats concurrents.
- Préparés non exécutés : migrations/RLS PostgreSQL, intégration Supabase, Stripe test externe, coffre-fort macOS, environnement préproduction distant, alertes hébergées.
- Le cache hors ligne ne peut connaître une révocation intervenue sans réseau : il reste borné à l’échéance signée serveur. Il ne prouve jamais un nouveau paiement. Il ne résiste pas à un administrateur local contrôlant le binaire, le coffre-fort et l’horloge ; aucune garantie matérielle n’est revendiquée.

## Références d’implémentation

- [Keyring 3.6.3 et backends natifs](https://docs.rs/keyring/3.6.3/keyring/).
- [Transactions et concurrence Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/).
- [Stockage SQLite Durable Objects](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).

## Prompt pour la phase 5

Réalise uniquement la phase 5 du projet commercial Scénario : IA côté serveur et quotas atomiques, avec fournisseur de développement injectable. Travaille exclusivement dans `scenario-app-commercial` sur `codex/commercial-v1` et `scenario-site-commercial` sur `codex/commercial-platform`. Ne modifie jamais les dépôts source, leurs branches main ou le dossier mac. Ne pousse, ne déploie et ne publie rien. Ne crée aucun compte externe, n’utilise aucun paiement réel et ne lance aucun appel IA payant sans autorisation explicite. Si les identifiants nécessaires ne sont pas déjà fournis, utilise des simulations locales isolées et documente les validations bloquées.

Lis d’abord les documents et contrats des phases 0 à 4, notamment `08-PHASE-4-PREPRODUCTION.md`, les contrats v4, les sessions/coffres-forts, le limiteur distribué, les Workers et toutes les migrations. Vérifie l’état Git et les validations déjà effectuées sans refaire ce qui est terminé. Préserve les contrats publics ; versionne et documente toute évolution. Ne considère pas les fixtures locales ou les tests SQL statiques comme une preuve de validation Supabase/Stripe réelle.

Implémente les routes IA authentifiées, un adaptateur fournisseur serveur injectable et un faux fournisseur déterministe. Migre les fonctionnalités IA commerciales du client vers cette API, y compris les anciens appels directs au fournisseur, sans toucher aux sources. Aucun secret, modèle facturé, prix, quota, droit ou règle commerciale ne doit être décidé par le client. Le serveur doit vérifier la version minimale, les droits effectifs, les appareils et les limites de débit avant chaque opération. Les quotas d’actions courtes et d’imports PDF doivent rester distincts et provenir de la configuration serveur versionnée.

Ajoute une réservation atomique des quotas avec clé d’idempotence liée au compte et au contenu de la demande, confirmation d’usage après succès et traitement documenté des erreurs, annulations, timeouts et réponses incertaines. Les retries et appels concurrents ne doivent ni dépasser les quotas ni débiter deux fois. Conserve un historique d’usage append-only lié au snapshot de droits et au request_id. N’enregistre jamais le texte des scénarios, prompts, réponses ou secrets dans les logs ; limite tailles, durées et formats des requêtes. Ajoute des contrôles d’autorisation et RLS, sans transformer un cache hors ligne en autorisation d’appel IA.

Ajoute les tests unitaires, de concurrence et bout en bout locaux couvrant succès, quota épuisé, droits absents, utilisateur tiers, idempotence, retries, panne fournisseur, réconciliation d’une réponse incertaine, import PDF, session expirée et refus d’élévation. Préserve les fichiers et exports existants. Exécute tests, builds, typechecks, lint ciblé, recherche de secrets et compilations Worker à blanc ; applique les migrations uniquement à un environnement local jetable déjà autorisé. Documente les choix, les garanties, les limites et les commandes de validation, puis committe localement chaque worktree modifié sans pousser.

Dans la réponse finale, donne les commits créés, distingue ce qui est fonctionnel, simulé et encore dépendant d’environnements externes, liste les validations effectuées et termine par une section « Prompt pour la phase 6 » contenant un prompt complet prêt à copier pour la synchronisation cloud, les versions et les fondations Studio.
