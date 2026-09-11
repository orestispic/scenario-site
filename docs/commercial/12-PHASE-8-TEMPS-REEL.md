# Phase 8 — édition Studio temps réel

## Rejouabilité de la chaîne Supabase

La validation sur un Supabase local jetable a révélé que la phase 2 avait renommé `public.users` en `public.profiles`, tandis que les migrations immuables des phases 6 et 7 continuaient à déclarer des clés étrangères vers `public.users`. La migration corrective append-only `20260914500000_profile_identity_reference_bridge.sql` ajoute un registre privé minimal de clés d'identité, synchronisé à la création d'un profil, afin de rendre la chaîne historique rejouable sans modifier les migrations des phases 0 à 7. `public.profiles` reste la source d'identité canonique, le registre est protégé par RLS et n'accorde aucun accès à `anon` ou `authenticated`. Les nouvelles tables v8 référencent directement `public.profiles`.

Le lint PostgreSQL réel a ensuite détecté deux appels historiques à `digest` incompatibles avec le `search_path` restreint des RPC de restauration et suppression cloud, ainsi que cinq RPC cloud encore exécutables via le privilège implicite `PUBLIC`. La migration post-v8 `20260917100000_cloud_sync_runtime_hardening.sql` qualifie explicitement `extensions.digest`, retire les privilèges directs `anon`/`authenticated` et réserve ces RPC au `service_role`. Les signatures publiques restent inchangées.

## Périmètre livré

Le contrat public `2026-09-v8` complète v1–v7 sans les modifier. Les routes `POST /v7/studios/:id/realtime/*` sont authentifiées et utilisent les mêmes en-têtes de version, plateforme et appareil que v6/v7. Le Worker valide à nouveau le profil, la version minimale, les droits, l’appareil, le scénario non supprimé et le membership courant à chaque ticket, connexion, heartbeat, poll, opération et compaction. Un viewer peut se connecter en lecture seule mais toute mutation est dissimulée comme une ressource non accessible.

Le transport `RealtimeCollaborationTransport` est injectable. `DeterministicLocalRealtimeTransport` fournit une exécution locale sans réseau ; `CloudflareRealtimeTransport` est le pont vers un Durable Object ou canal compatible. Aucun bearer token n’est transmis au canal. La liaison Cloudflare réelle n’est pas déclarée dans `wrangler.preproduction.toml`, puisqu’aucune infrastructure isolée n’est fournie : l’entrée de production répond `collaboration_unconfigured` au lieu de retomber sur une mémoire d’isolate.

## Tickets et connexions

Un ticket contient 256 bits dérivés avec un secret serveur et n’est rendu que dans le corps JSON. Le faux serveur n’en garde que le SHA-256. Le ticket expire après 30 secondes, n’a qu’un usage et est lié au profil, Studio, appareil et origine. Il n’est jamais placé dans une query string, un log ou `localStorage`. Une reprise exige un nouveau ticket et ne remplace jamais l’autorisation serveur.

La présence est calculée à partir des connexions vivantes dans le canal et n’est ni une autorité, ni une table historique. Heartbeat local : 10 s ; connexion morte : 30 s ; durée maximale : 3 600 s ; reconnexion cliente exponentielle bornée à 30 s. Chaque requête revalide l’accès. Une révocation de membership, d’appareil ou une déconnexion ferme les connexions du profil immédiatement côté transport ; une session expirée est refusée avant l’accès au canal. Le Durable Object devra en plus pousser une fermeture dès réception de l’invalidation, le heartbeat restant un filet de sécurité.

Bornes locales : 32 connexions par Studio, 3 par profil, opération de 64 KiB, backlog de 500 événements et page de 100 événements. Un dépassement ferme ou refuse sans accepter une mutation. Une panne de canal retourne 503 ; le fichier local reste éditable et les opérations non confirmées restent en mémoire jusqu’à reprise ou création volontaire d’une copie.

## CRDT de blocs

La stratégie `scenario-block-lww-v1` est un CRDT de registres LWW au niveau des blocs Tiptap stables (`attrs.blockId`). Elle n’impose pas un nouvel éditeur. Une enveloppe contient `studioId`, `scenarioId`, `baseVersionId`, `operationId`, séquence cliente, horloge logique, mutation, checksum ; le serveur injecte l’acteur autorisé, le curseur, la date et `request_id`.

- Des blocs distincts convergent indépendamment.
- Pour un même bloc, l’ordre total est `(logicalClock, actorId, operationId)` ; il est déterministe sur tous les nœuds.
- Une suppression est un tombstone. Une écriture plus ancienne ne ressuscite pas le bloc.
- Toute concurrence entre acteurs sur le même bloc produit aussi un conflit append-only, même lorsque l’ordre total permet de converger.
- Le client reçoit `keep_local`, `accept_remote`, `create_copy`. La copie contient les opérations locales non confirmées et n’écrase aucune version.
- Les opérations en double sont rejouées si leur checksum concorde et refusées sinon. Les événements dupliqués ou hors ordre sont triés/dédupliqués par `cursor` et `operationId`.

Cette première tranche collabore sur le corps du scénario. Couverture, commentaires et autres métadonnées continuent à suivre le fichier/version v6 afin d’éviter une fusion partielle implicite. Leur passage à des types CRDT dédiés devra être versionné dans un contrat ultérieur.

## Persistance et compaction

`20260917000000_studio_realtime_collaboration.sql` est strictement postérieure à la migration v7. Elle ajoute opérations, conflits, résolutions, snapshots, accusés, tickets empreintés et journal de compaction. Les opérations, conflits, résolutions, snapshots et compactions sont immuables. Les accusés et tickets sont des projections bornées. Toutes les écritures métier sont réservées au `service_role`; RLS n’expose en lecture que les journaux du membre actif.

Une compaction crée un snapshot avec parent v6 explicite, parent de snapshot optionnel, curseur, checksum et clé objet. Elle est idempotente par empreinte. Les opérations/tombstones d’audit ne sont pas modifiés : seul le curseur minimal de reprise peut avancer après accusé de tous les clients et rétention. Un curseur trop ancien donne un conflit explicite et impose snapshot ou copie. Le faux transport réalise cette logique en mémoire. L’adaptateur Supabase/R2 et le Durable Object réels restent à valider.

Ordre de panne : les octets du snapshot sont écrits dans le stockage privé avant le commit SQL ; un échec objet n’insère rien. Si SQL échoue après upload, l’objet est orphelin et doit être nettoyé par inventaire différentiel. Si SQL réussit mais la diffusion échoue, le journal SQL demeure la vérité et le canal recharge depuis le curseur. Une panne DB refuse opérations et compactions ; la présence peut rester affichée comme dégradée mais ne permet aucune écriture.

## Observabilité et exploitation

Les métriques n’acceptent que route normalisée, statut, durée, issue temps réel et `request_id`. L’audit local conserve action, Studio, curseur et `request_id`; jamais bloc, texte, mutation brute, ticket, e-mail, jeton, URL ou secret. En production, corréler `request_id` et un identifiant de connexion haché, sans en faire un label à forte cardinalité.

Seuils initiaux : alerte si connexions >80 % de capacité pendant 5 min, latence p95 de diffusion >750 ms pendant 10 min, backlog p95 >250, reconnexions >5/min/Studio, rejets d’autorisation >5 % ou échec de compaction >1 % sur 15 min. Procédure : geler les nouvelles connexions, drainer les connexions existantes, conserver les opérations SQL, remplacer le secret de tickets, invalider les tickets non consommés, relancer le canal depuis le dernier snapshot puis le curseur SQL, et comparer compteurs/checksums. Un replay ne publie jamais deux fois une attribution : `operationId` et empreinte de compaction sont les clés de déduplication.

Une investigation utilise uniquement période, route, statut, request_id, Studio pseudonymisé, curseur et checksum. L’accès exceptionnel au contenu exige la procédure d’accès aux données du produit, hors logs. La rotation de `STUDIO_TICKET_PEPPER` invalide tous les tickets émis ; les connexions existantes sont drainées puis recréées.

## État des validations

Fonctionnel localement : protocole HTTP, trois comptes, présence, heartbeat/timeout, reprise, déduplication, concurrence, conflits/tombstones, viewer, révocations, capacité/backpressure, compaction idempotente, interface Tiptap progressive et copie de récupération. La chaîne complète des migrations a aussi été rejouée sur Supabase local après une remise à zéro ; les cinq fichiers pgTAP passent. Ils couvrent notamment RLS, privilèges RPC, registre d'identité privé et consommation unique d'un ticket. Le lint PostgreSQL ne conserve que les avertissements d'arguments volontairement inutilisés afin de préserver les contrats RPC v7.

Simulé : droits métier, stockage Studio, transport temps réel, snapshots et diffusion applicative utilisent toujours des adaptateurs mémoire déterministes. Supabase Auth, PostgreSQL, les migrations, RLS et RPC de sécurité ont en revanche été exécutés réellement dans la pile locale Docker.

Encore bloqué faute d’infrastructure isolée fournie : stockage objet test, Durable Object Cloudflare, mesure réelle de diffusion et invalidation push. Aucun compte ni ressource externe n’a été créé.

Commandes validées sur la pile locale jetable :

```powershell
npx.cmd supabase start
npx.cmd supabase db reset --local
npx.cmd supabase test db
```

Validation Cloudflare encore attendue, seulement après création d'une infrastructure de test isolée :

```powershell
npx wrangler dev --config wrangler.preproduction.toml --local
npx wrangler deploy --config wrangler.preproduction.toml --dry-run --outdir .wrangler/phase8-preproduction
```

Ne jamais utiliser `supabase db push`. Avant le test Cloudflare, créer explicitement un Durable Object de test implémentant le protocole interne `x-command`, déclarer la liaison `STUDIO_REALTIME_CHANNEL`, injecter `STUDIO_TICKET_PEPPER` par secret local et vérifier qu’aucune ressource de production n’est référencée.
