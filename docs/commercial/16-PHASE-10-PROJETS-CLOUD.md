# Phase 10 — API projets et fiabilisation du journal

## Modèle et protocole

Un projet correspond à `cloud_scenarios`, avec versions v6 append-only et fichiers
privés. `studios.scenario_id` est déjà UNIQUE : un Studio technique ne partage
donc qu'un projet. Aucune duplication d'équipe globale ni migration de contenu.
La liste distingue privé/partagé selon les membres actifs, pas selon l'offre.
Préparer le partage sans inviter personne garde le projet privé (un seul membre).

Contrat v9 distinct, conservant intégralement v1–v8 :

| Route | Résultat / contrôle |
| --- | --- |
| GET `/v9/projects` | Projets accessibles, rôle, membres, `canShare`, invitations reçues, canal et `realtimeBaseVersionId` autorisés |
| POST `/v9/projects/:id/sharing` | Corps `{}`, propriétaire seulement, Studio unique, réponse rejouable |
| POST `/v9/project-invitations/:id/respond` | `{decision: accept ou decline}`, destinataire authentifié et empreinte e-mail vérifiée côté Worker |

Les identifiants d'invitation ne sont pas des credentials. Aucun token
d'invitation n'est remis par v9. Les anciens endpoints v7/v8 restent utilisables.
Les fonctions SQL ne sont exécutables que via service_role côté serveur ; RLS et
protections dernier owner antérieures restent actives. Les appels v9 traversent
authentification, limites de débit, version minimale, appareil et droits cloud.
Partager/recevoir une invitation nécessite aussi le droit de collaboration.

Migration append-only `20260923000000_cloud_projects.sql` : nouvelles RPC,
`studios.project_base_version_id`, validation de base immuable appartenant au
projet, verrouillage invitation/Studio, révisions de membership et événements
append-only. Le premier partage v9 fixe la dernière version privée comme base.
Les Studios antérieurs gardent leur racine historique. Les opérations v9 soumises
via le protocole v8 doivent référencer cette base, contrôlée en SQL.

Les RPC publiques v6 de sauvegarde/restauration gardent leur signature/réponse.
Des wrappers revérifient le membership avant de restituer un résultat historique
d'idempotence ; le retrait de membre et l'écriture se sérialisent sur le Studio.
Les implémentations internes renommées ne sont pas directement exécutables par
service_role. Un ancien Éditeur révoqué ne récupère plus une réponse de sauvegarde
historique. Les 15 migrations antérieures sont gelées par SHA-256 normalisé LF,
y compris les correctifs intermédiaires ; aucun fichier historique modifié.

## Journal durable et panne partielle

Le Durable Object SQLite garde maintenant une outbox versionnée dans le même
`put` que l'état du canal. Une alarme est armée avant cette écriture atomique.
Après acceptation locale, la confirmation attend l'insertion SQL. Réponse
incertaine : l'opération reste durable, son ID/checksum/request_id sont rejoués,
sans dépendre du retour en ligne de l'auteur. La RPC SQL revalide les droits et
déduplique. Un poll public est toujours conditionné à la vérification du journal.
Les anciens appels de réconciliation restent idempotents et compatibles.

Bornes : 32 entrées non confirmées, lot de 8 dans l'ordre, timeout SQL 8 s,
backoff exponentiel plafonné à 256 s, stockage sérialisé inférieur à 1 MiB.
Cloudflare documente une limite de valeur SQLite de 2 MB ; la marge est volontaire
([limites officielles](https://developers.cloudflare.com/durable-objects/platform/limits/)).
Une erreur de stockage restaure l'état précédent en mémoire. Compaction refusée
tant qu'il reste une outbox. Aucun contenu/opération brute/email/ticket dans les
journaux : seulement `studio.outbox_retry` / `studio.outbox_blocked`, request_id,
tentatives et profondeur.

Une erreur terminale 400/403/404/409/426 met l'entrée en quarantaine, sans supprimer
le contenu ni contourner la révocation. La file reste bloquée dans l'ordre ;
aucune attribution silencieuse à un autre auteur. Les lignes opérations déjà
acceptées avant cette phase restent couvertes par la réconciliation héritée.

Stockage objet écrit mais SQL refusé : objet non référencé possible, jamais
exposé sans autorisation. SQL accepté et canal indisponible : reprise par curseur,
pas d'acquittement inventé. Canal persisté et SQL incertain : outbox + alarme.
SQL/base révoquée : quarantaine + récupération d'une copie locale.

## Exploitation

- Alerter sur `studio.outbox_blocked` dès la première occurrence ; sur backlog
  non nul pendant plus de 2 minutes ou hausse répétée de 503. Corréler par
  request_id ; ne pas ajouter le contenu aux logs pour diagnostiquer.
- Pour une panne transitoire SQL, restaurer le service puis observer la vidange
  automatique et la reprise des polls. Ne pas renvoyer une opération avec un
  nouvel ID ; la même clé préserve l'unicité.
- Pour une quarantaine, conserver les fichiers des utilisateurs et l'état
  durable, vérifier droits/appareil/base/journal par identifiants. Aucun endpoint
  de déblocage administratif aveugle n'est exposé. Une réparation doit être
  ciblée, testée et auditée ; à défaut, utiliser une copie dans un nouveau projet.
- Ne pas détruire le DO ou retirer la migration pour purger un incident. Le
  journal SQL et les versions sont immuables. Une ancienne version Worker ne
  connaît pas l'outbox : ne pas revenir en arrière avec une file non vide.
- Les procédures de drainage, rotation de secret et invalidation de tickets des
  phases 8/9 restent applicables. La phase 10 n'active pas de notification externe.

L'ingress par IP est séparé du budget authentifié (préproduction : 1200/min/IP,
60/min/compte). Clés HMAC, stockage distribué, panne fermée restent inchangés.
Les budgets temps réel dédiés restent actifs. Cette correction supprime le
partage accidentel du petit budget de compte entre tous les comptes d'une IP ;
elle n'est pas une preuve de capacité sous charge de production.

## Validation et limites

Exécuté localement : 120 tests API/contrats (dont concurrence, sessions, Stripe
simulé, IA simulée, quotas, versions, RLS statique), typecheck, lint ciblé, build
site, scans de secrets serveur/client, compilation Worker à blanc (187,30 KiB).
Application : 105 tests, build/typecheck, Edge isolé, menus, 3 tests Rust passés
et 1 test de coffre natif explicitement ignoré.

Exécuté réellement sur PostgreSQL de préproduction AVANT application : transaction
BEGIN + migration + fixture + ROLLBACK. Deux projets synthétiques, dernier état
privé choisi comme base, propriétaire/éditeur/lecteur, mauvais destinataire
refusé, acceptation/replay, isolation et révocation/replay refusé. Aucun changement
de cette transaction n'a été conservé. Ce n'est ni un test SQL statique ni un
Supabase local. Docker/psql local non disponibles dans cette session.

Commandes exécutées dans ce worktree :

```powershell
git status --short --branch
git diff --check
npm.cmd run typecheck
node --experimental-transform-types --test --test-reporter=spec worker/tests/*.test.ts tests/*.test.ts
.\node_modules\.bin\oxlint.cmd worker/src/cloudProjects.ts worker/src/cloudSync.ts worker/src/collaborationLedger.ts worker/src/index.ts worker/src/localRuntime.ts worker/src/observability.ts worker/src/studio.ts worker/src/studioRealtimeChannel.ts worker/src/types.ts worker/src/worker.ts worker/tests/phase10-projects.test.ts worker/tests/studio-realtime-channel.test.ts tests/phase10-migrations.test.ts scripts/phase10-validate-hosted-projects.mjs
npm.cmd run build
npm.cmd run test:security
node scripts/security-check.mjs --app
.\node_modules\.bin\wrangler.cmd deploy --dry-run --config wrangler.preproduction.toml
.\node_modules\.bin\supabase.cmd migration list --linked
.\node_modules\.bin\supabase.cmd db query --linked --file outputs/phase10-transaction.sql
```

`outputs/phase10-transaction.sql` est l'assemblage temporaire de BEGIN, migration,
`supabase/tests/phase10_projects_transaction.sql`, ROLLBACK (dans cet ordre).
Ne jamais exécuter la fixture seule : elle suppose une transaction annulée.
Le script `phase10-validate-hosted-projects.mjs --execute` est limité en dur à la
préproduction `zblnsdyaoljnezxdidtx` et au Worker de préproduction. Il utilise les
3 comptes existants et place ses seuls projets synthétiques dans la corbeille.
La section suivante consignera la mise à jour et les validations hébergées.

Limites restant hors preuve : charge importante, soak long, suspension/veille
multiappareil, panne réelle injectée de Cloudflare/SQL, restauration administrative
d'une outbox en quarantaine. Le test d'alarme après éviction est local simulé.
Le canal conserve encore l'historique dans un état borné ; la compaction actuelle
ne fournit pas de rétention illimitée. La collaboration reste par blocs, et les
métadonnées de couverture/commentaires ne sont pas coéditées. Pas de publication
production, nouveau compte externe, paiement, IA payante ou push Git.
