# Correction de stabilité du temps réel

## Diagnostic reproduit

Le test `node scripts/realtime-soak.mjs 120`, lancé depuis le worktree application,
utilise réellement `StudioCollaborationClient` et son adaptateur HTTP avec les trois
comptes synthétiques du projet `zblnsdyaoljnezxdidtx`. Il ne soumet aucun texte.
Sa première exécution a échoué pendant deux minutes pour les trois profils avec
`collaboration_ledger_incomplete`, puis avec l'expiration des connexions.
Un test rapide des endpoints ne prouvait donc pas la stabilité du client.

La contrainte SQL UNIQUE(studio_id, actor_profile_id, client_sequence) était
incompatible avec v8 : une instance cliente recommence sa séquence après un
rechargement, et plusieurs appareils utilisent des séquences indépendantes.
Le canal appliquait les opérations avant que SQL ne refuse leurs séquences.
Tout lecteur rencontrant ces opérations échouait ensuite lors de l'acquittement.

## Persistance et réparation

La migration `20260922000000_studio_operation_sequence_scope.sql` supprime uniquement
cette unicité et conserve un index non unique pour l'investigation. Les UUID,
checksums, curseurs, acteurs, clés étrangères, RLS, RPC et triggers d'immutabilité
restent inchangés. Aucune ancienne migration n'est réécrite.

Le poll réconcilie au maximum huit opérations manquantes de son propre auteur
avant l'acquittement. Il reprend l'UUID, le checksum et le request_id originaux
provenant du canal privé. La RPC revalide les droits, le membership, l'appareil et
la version cliente actuels. Aucun lecteur n'usurpe l'auteur d'une autre opération.
Le mécanisme reste idempotent en cas de polls concurrents ou de panne après SQL.

Limite explicite : si un ancien auteur ne revient pas, ou n'a plus les droits,
ses opérations non persistées nécessitent une récupération opérateur. Elles ne
sont ni supprimées ni ignorées pour débloquer artificiellement les lecteurs.
Le modèle existant canal-puis-SQL reste une écriture entre deux systèmes, non une
transaction distribuée. Un déploiement de production devra compléter la reprise
par un outbox durable et une procédure de réconciliation opérateur.

## Client et concurrence

Une seule boucle orchestre connexion, lecture, heartbeat et envoi. Les générations
invalident les réponses tardives après arrêt, changement de compte ou remplacement
de module Vite. Les demandes du canal ont un timeout de huit secondes et sont
annulables. La fermeture du panneau n'arrête pas le canal ; ouvrir un autre fichier
arrête le canal du scénario précédent.

Le statut connecté n'apparaît qu'après une lecture réussie. Le backoff des échecs
de lecture ne repart pas à zéro parce qu'un heartbeat réussit. Les heartbeats
continuent pendant ce backoff pour conserver une connexion encore valide.
Les 429 déclenchent une attente d'au moins une minute avec prise en compte de
Retry-After ; le rattrapage et l'envoi sont espacés de quatre secondes.

Les erreurs 401 `collaboration_connection_closed` et `collaboration_ticket_invalid`
ne détruisent pas la session du compte. Les autres refus d'authentification,
d'appareil, de membership ou de version ferment le canal. Un curseur trop ancien,
un conflit ou une saturation locale arrête les retries et propose une récupération.
Les notifications v8 `connection.closed` ne désignent qu'un profil : un événement
historique ne peut pas révoquer une nouvelle connexion. Chaque lecture et heartbeat
reste soumis à l'autorisation serveur actuelle.

Les opérations jamais envoyées sur le même bloc sont regroupées. Une demande déjà
tentée conserve son identité et son checksum lors des retries. Un acquittement
d'écriture ne fait jamais avancer le curseur de lecture au-delà de modifications
distantes non encore lues. Une collision locale/distante garde le texte local et
requiert une récupération explicite. Les copies restent en mémoire jusqu'à l'arrêt
ou au téléchargement ; le fichier local complet reste la source de récupération.

Le Durable Object sérialise autorisation, mutation et persistance dans une file
bornée à 64 commandes pour empêcher l'état d'autorisation d'un autre profil de
remplacer celui d'une requête en cours à travers les points await.

## Diagnostic et exploitation

Le test de stabilité n'affiche que rôles synthétiques, états, compteurs et codes
d'erreur bornés. Le panneau affiche un code de diagnostic et un request_id éventuel,
jamais un ticket, un prompt, une opération ou une réponse de scénario.
Les scripts ferment exclusivement leurs propres canaux puis leurs sessions
Supabase avec `scope=local`. L'appel de logout global du Worker a été retiré du
diagnostic : il révoquait aussi les onglets interactifs du même compte.

Le moteur Docker local est indisponible sur cet hôte. La migration a été exercée
sur PostgreSQL hébergé dans une transaction annulée, avec insertion d'une seconde
opération de même séquence et UUID distinct. Ce contrôle n'est pas une validation
Supabase locale.

## Commandes de validation

Application : `npm.cmd test -- --run`, `npm.cmd run build`,
`node scripts/realtime-soak.mjs 120` (préproduction uniquement).

Plateforme : `npm.cmd run test:api`, `npm.cmd run typecheck`, lint ciblé des fichiers
modifiés, `npm.cmd run test:security`, `node scripts/security-check.mjs --app`,
`wrangler deploy --dry-run --config wrangler.preproduction.toml`.

Base : `supabase migration list --linked`, contrôle SQL transactionnel annulé,
puis application ciblée avec `supabase migration up --linked` après vérification
qu'une seule nouvelle migration est en attente. Ne pas utiliser `db push`.

## Résultat de cette intervention

Les 107 tests plateforme passent, ainsi que le typecheck, le lint ciblé, les scans
de secrets (plateforme et application) et la compilation Worker à blanc. Les
anciens fichiers de migration restent inchangés. Le client passe 82 tests et son
build préproduction est vérifié séparément.

La validation hébergée initiale de 120 secondes avait reproduit le blocage ; elle
n'était pas un succès post-correction. Le premier refus du contrôle automatique
(ancienne restriction à Supabase local) a ensuite été levé par l'autorisation
explicite de l'utilisateur pour cette migration, ce commit et les tests.

## Application et validation réelles après autorisation

Le worktree plateforme était propre sur `6ebd21ce590551fd2060997aad199cc2482b31ce`
et le projet lié était exactement `zblnsdyaoljnezxdidtx`. La liste distante montrait
une seule migration en attente : `20260922000000`. Elle a été appliquée avec
`supabase migration up --linked`, sans `db push`.

Contrôle SQL après application : migration inscrite, ancienne unicité de séquence
absente, index de recherche présent, RLS toujours activée et contraintes uniques
`(studio_id, cursor)` et `(studio_id, operation_id)` conservées. Un compteur SQL
agrégé confirme qu'un groupe de séquences réutilisées est désormais persisté ;
aucun texte ni identité n'a été affiché.

Le commit autorisé `6ebd21c` a été déployé sur
`scenario-commercial-api-preproduction`. Version Cloudflare retournée :
`bee273c7-bde7-4509-aa02-ee1a2cf7f016`. Wrangler a signalé la différence de
configuration distante `observability.redact_query_string: false` ; le déploiement
a utilisé la configuration préproduction du commit. Aucun secret n'a été remplacé.

Le premier passage post-déploiement de 120 secondes reste **en échec strict** :
deux réponses `collaboration_ledger_incomplete` pour owner pendant le rattrapage
initial. Après connexion de l'editor et réparation des opérations de leur propre
auteur, les trois clients sont restés stables, sans nouvelle connexion. Compteurs
finaux owner/editor/viewer : lectures 31/29/29, heartbeats 11/11/11, une connexion
par rôle. Ce passage de récupération ne compte pas comme test sans erreur.

Le test hébergé rapide a ensuite réussi : présence des trois rôles, ticket à usage
unique, refus d'écriture viewer, opération existante rejouée et dédupliquée,
rattrapage monotone de 51 événements, une seule ligne SQL pour l'opération test,
snapshot privé existant vérifié par checksum et version cloud, déconnexion et
reprise au curseur 51. Il n'a pas créé de nouveau snapshot ni validé une nouvelle
compaction. Il ferme uniquement ses propres canaux et sessions Supabase locales.

Le nouveau test `node scripts/realtime-soak.mjs 300` a **réussi** (code de sortie
0) : cinq minutes avec le vrai client applicatif et les trois comptes, aucune
erreur HTTP, aucun statut de reconnexion et une seule connexion par compte.
Chacun a effectué 71 lectures et 29 heartbeats. Owner/editor sont restés `online`,
viewer `read_only`. Le client testé est celui du commit application `46290ce`.
Ces résultats sont des validations réelles du Worker/Supabase de préproduction,
pas des simulations ni une compilation à blanc. Le module corrigé servi par Vite
sur `http://127.0.0.1:1420/src/commercial/collaborationClient.ts` a aussi été vérifié
(HTTP 200 et présence des gardes de génération/récupération/espacement des polls).

Portée : le soak ne soumet pas de nouvelle édition et n'est pas un test de charge,
de veille navigateur, de coupure réseau injectée ou de durée supérieure à cinq
minutes. Les limites de double écriture et de fusion de blocs décrites plus haut
demeurent ; ce résultat ne vaut pas garantie générale de disponibilité en
production. Aucun code supplémentaire n'a été modifié après le déploiement :
les commits de compte rendu suivants ne changent que la documentation.

Commandes exécutées pour cette application (depuis le worktree plateforme, sauf
le soak lancé depuis le worktree application) :

```powershell
git status --short --branch
git rev-parse HEAD
Get-Content supabase/.temp/project-ref
.\node_modules\.bin\supabase.cmd migration list --linked
.\node_modules\.bin\supabase.cmd migration up --linked
.\node_modules\.bin\wrangler.cmd deploy --config wrangler.preproduction.toml
node scripts/realtime-soak.mjs 120
npm.cmd run phase9:realtime:validate -- --project-ref zblnsdyaoljnezxdidtx --api-url https://scenario-commercial-api-preproduction.ore-picard.workers.dev
node scripts/realtime-soak.mjs 300
git diff --check
```

Les contrôles de schéma ont été exécutés avec `supabase db query --linked` :

```sql
select version from supabase_migrations.schema_migrations
where version = '20260922000000';
select
  (select count(*) from pg_constraint
   where conrelid = 'public.studio_collaboration_operations'::regclass
     and contype = 'u'
     and pg_get_constraintdef(oid) = 'UNIQUE (studio_id, actor_profile_id, client_sequence)')
    as old_sequence_unique,
  (select count(*) from pg_indexes
   where tablename = 'studio_collaboration_operations'
     and indexname = 'studio_collaboration_actor_sequence_lookup_idx')
    as sequence_lookup_index,
  (select relrowsecurity from pg_class
   where oid = 'public.studio_collaboration_operations'::regclass) as rls_enabled,
  (select json_agg(pg_get_constraintdef(oid)) from pg_constraint
   where conrelid = 'public.studio_collaboration_operations'::regclass
     and contype = 'u') as remaining_unique_constraints;
select count(*)::int as reused_sequence_groups from (
  select studio_id, actor_profile_id, client_sequence
  from public.studio_collaboration_operations
  group by studio_id, actor_profile_id, client_sequence having count(*) > 1
) repaired;
```
