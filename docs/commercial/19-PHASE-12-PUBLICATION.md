# Phase 12 — préparation publiable, bêta toujours privée

## Réalisé

- Rubriques liées depuis le pied de page : support, confidentialité, conditions de
  bêta, mentions légales provisoires. Les informations commerciales non validées
  sont signalées, pas inventées. Aucun faux e-mail support ni SLA annoncé.
- SIRET utilisateur vérifié le 12/09/2026 via recherche-entreprises.api.gouv.fr :
  95295149900013, ORESTIS PICARD (ORESTIS PRODUCTION), établissement actif.
  Aucune adresse personnelle copiée. `release/legal-review.json` garde les champs
  manquants et le statut draft-not-approved ; aucune approbation juridique automatique.
- Confirmation e-mail explicite : TokenHash consommé en mémoire et retiré de l'URL,
  confirmation signup distincte de recovery, session temporaire fermée après usage,
  nouvelle connexion préservée si une ancienne confirmation échoue tardivement.
  Les contrats publics précédents sont conservés ; la fonction takeRecoveryHash
  délègue au parseur commun sans changer son résultat historique.
- Traitement des liens reçus dans le même onglet par hashchange. L'E2E a révélé
  ce cas et prouve maintenant la confirmation après une récupération dans cet onglet.
- Modèle de confirmation Supabase prêt à installer, complément du modèle recovery.
  Aucun changement de template distant, inscription réelle ou e-mail envoyé.
- En-têtes Vercel nosniff, no-referrer, noindex et restriction caméra/micro/géolocalisation.
- Suppression du badge « le plus choisi » sans statistique ; « pour les auteurs ».
- Vérificateur hors ligne de sauvegarde base + objets/parents/checksums, sortie sans
  contenu ni identifiants ; politique d'incident pure avec déduplication/reprise et
  rejet des échantillons temporels dupliqués ou anciens. Ces modules ne constituent
  ni une sauvegarde hors site ni un moniteur actif.
- Dossier opératoire `release/PHASE-12-OPERATIONS.md` : messagerie/DNS, registre des
  données, CGU/CGV à finaliser, demandes d'export/suppression, sauvegarde/restauration,
  alertes, retour arrière et recette des trois offres.

Application : voir `16-PHASE-12-PUBLICATION.md` dans le worktree app pour les
libellés, aide/version, contrôleur de préparation des mises à jour et NSIS.

## Validation locale effectuée

Site : 149 tests API/contrats/migrations, typecheck, lint ciblé, sécurité serveur
(103 fichiers) et client (84 fichiers), build beta. 17 migrations antérieures
restent immuables ; aucune migration ajoutée ni appliquée. E2E Edge intercepté :
trois offres et toggle, connexion/compte/logout, mobile, Checkout simulé,
récupération et confirmation d'inscription explicite ; aucun jeton persistant.
Confirmation unitaire : lien expiré/refusé, hash invalide, fermeture temporaire et
réponse tardive ne supprimant pas une nouvelle session. Intégrité : altération,
parents manquants/cycle, chemin sortant ; incident : ouverture unique/rétablissement.

Application : 123 tests, build avec typecheck, NSIS x64 local et 3 tests Rust réussis.
Le test OS keyring explicitement ignoré n'a pas été relancé car le coffre n'a pas
changé. Exe NSIS non signé : 3 464 068 octets,
SHA-256 `65a28ddefb89d0bc3006f8636c1501f0f53631c48a7d398a1fd71a92574351b9`.
Pas d'installation/désinstallation ni de mise à jour réelle sur VM.

Commandes exécutées dans le worktree site, sauf mention app :

```powershell
npm.cmd run typecheck
npm.cmd run test:api
node --experimental-transform-types --test tests/phase12-email.test.ts tests/phase12-operations.test.ts tests/phase11-browser.test.ts
npm.cmd exec oxlint -- src/beta.tsx src/information.tsx lib/commercial/browser-account.ts scripts/backup-integrity.mjs scripts/alert-policy.mjs tests/phase12-email.test.ts tests/phase12-operations.test.ts scripts/phase11-site-e2e.mjs
npm.cmd run test:security
node scripts/security-check.mjs --app
npm.cmd run build:beta
$env:SCENARIO_PLAYWRIGHT_PATH='C:\Users\orepi\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\playwright\index.mjs'
$env:SCENARIO_TEST_SITE_URL='http://127.0.0.1:4174'
node --experimental-transform-types scripts/phase11-site-e2e.mjs
npm.cmd run release:check
# App
npm.cmd test
npm.cmd run build -- --mode phase9
npm.cmd run build:beta
cargo test --manifest-path src-tauri/Cargo.toml --locked
& scripts/inspect-beta-installer.ps1
git diff --check
```

La première exécution E2E a détecté hashchange non géré (corrigé, retest réussi).
Le premier lancement esbuild app bloqué par le sandbox a réussi hors sandbox.
Trois erreurs lint de conversion URL dans les tests ont été corrigées et revérifiées.
Le gate publication garde volontairement ses 10 prérequis ouverts ; le SIRET ne
remplace pas la validation des politiques. Avertissements de taille du bundle app
et de sortie linker Windows déjà connus, aucun échec de compilation restant.

## Encore nécessaire avant ouverture

Boîte support/SMTP et livraison réelle (dont invitations), coordonnées et revue des
textes, régions/rétention/export/suppression, certificat Windows, adaptateur updater
natif/signature/endpoint et test sur VM, sauvegarde hors site avec restauration SQL
et objets réelle, collecte continue/alertes reçues, production métier et Stripe live
revus séparément, branchement du domaine et validation HTTPS. Le seul contrôleur
de mise à jour simulé ne suffit pas à fermer le gate updater.

Sources légales et techniques dans le dossier opératoire. La publication publique
et les téléchargements restent fermés. Prévisualisation mise à jour : résultat et
URL consignés en addendum après déploiement. Aucun push.
