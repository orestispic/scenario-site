# Phase 6 — synchronisation cloud et fondations Studio

## État livré

Le contrat public `2026-09-v6` ajoute la synchronisation de fichiers `.scenario` sans modifier v1–v5. Les routes `/v5/scenarios` sont toutes authentifiées et revalident, à chaque opération, la version minimale, le snapshot de droits courant (`cloud_sync` et `scenario_versions`) et l’appareil actif. Un cache hors ligne n’est jamais consulté par le Worker.

`POST /v5/scenarios/sync` accepte un document JSON borné, MIME `application/vnd.scenario+json`, format `scenario-v1`, taille et SHA-256 concordants. Le Worker fabrique lui-même une clé objet sans titre ni identifiant de compte brut. L’upload est médié par le Worker : aucune URL d’upload réutilisable n’est remise au client. Les URLs de téléchargement sont signées/opaques, liées au profil et au scénario par l’adaptateur, et expirent entre 30 et 900 secondes (300 par défaut). L’adaptateur local permet de tester signature, compte et expiration ; Supabase Storage n’est appelé qu’en entrée de production.

Chaque version lie scénario stable, auteur, parent, numéro, checksum, taille, MIME, format, origine, snapshot de droits et `request_id`. Les versions et le registre d’idempotence sont immuables. La clé brute d’idempotence est HMACée avec le profil ; les retries identiques rejouent la réponse, une réutilisation avec un contenu différent échoue. Un verrou transactionnel par scénario et le parent courant réalisent le contrôle optimiste ; le client reçoit 409 et seulement `keep_local`, `download_remote`, `create_copy`. Restaurer crée une nouvelle version ; supprimer est logique et réservé au propriétaire.

Les rôles minimaux sont `owner`, `editor`, `viewer`. La migration étend `scenario_collaborators` avec `invited|active|revoked`, sans envoyer d’e-mail et sans temps réel. Les interfaces `CollaborationNotifier` et `CollaborationChannel` préparent l’injection future sans activer de collaboration.

La télémétrie ne sérialise jamais requêtes, corps, titre, commentaire, URL signée, jeton ou clé. Elle conserve seulement route normalisée, méthode, statut, durée, résultat cloud et `request_id`.

## Stockage et environnements

Le faux local est en mémoire, déterministe et isolé. L’adaptateur de production utilise Supabase REST/RPC et un bucket privé fourni par `CLOUD_STORAGE_BUCKET`. Aucun projet Supabase ni bucket n’a été créé : identifiants, CLI et Docker ne sont pas disponibles. Les modèles et paiements des phases précédentes ne sont pas invoqués par les tests cloud.

La préproduction ajoute seulement des bornes non secrètes. `CLOUD_IDEMPOTENCY_PEPPER`, les clés Supabase test et les secrets précédents doivent venir du gestionnaire de secrets. Aucun secret n’est commité.

## Validation externe encore requise

Sur un Supabase local jetable déjà autorisé :

```powershell
supabase start
supabase db reset
supabase test db supabase/tests/phase6_cloud_sync.sql
```

Créer ensuite un bucket privé `scenario-documents-preproduction`, exécuter le Worker avec des identifiants test, puis vérifier deux JWT synthétiques owner/membre :

```powershell
npx wrangler dev --config wrangler.preproduction.toml --local
npx wrangler deploy --config wrangler.preproduction.toml --dry-run
```

Le `deploy --dry-run` ne publie rien. Ne jamais utiliser `supabase db push` ni `wrangler deploy` sans `--dry-run` dans cette phase.

## Commandes locales de référence

```powershell
npm run test:api
npm run typecheck
npm run build
npm run lint
npm run test:security
npx wrangler deploy --config wrangler.api.toml --dry-run
npx wrangler deploy --config wrangler.local-test.toml --dry-run
npx wrangler deploy --config wrangler.preproduction.toml --dry-run
```
