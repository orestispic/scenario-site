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

La validation hébergée de 120 secondes a reproduit le blocage existant ; elle
n'est pas un succès post-correction. La migration 20260922000000 et le Worker
corrigé **ne sont pas encore appliqués/déployés**. La demande d'exécution
`migration up --linked` a été refusée par le contrôle automatique, qui cite
l'ancienne restriction à Supabase local et le risque d'appliquer plusieurs
migrations. Une autorisation explicite ciblant cette migration et le Worker de
préproduction est requise avant de poursuivre. Le contrôle transactionnel annulé
n'a conservé aucun changement. Le moteur Docker local n'est pas disponible.

Après cette autorisation : revérifier que seule 20260922000000 est en attente,
appliquer la migration, vérifier son inscription, déployer le commit testé sur
`scenario-commercial-api-preproduction`, puis exécuter un premier passage de
réconciliation et un test neuf de stabilité de 120 secondes avec le vrai client.
Le succès exige zéro erreur, une connexion par compte, des lectures et heartbeats
continus, et la fermeture des seules sessions du diagnostic. Ne pas déclencher
le logout global des comptes interactifs.
