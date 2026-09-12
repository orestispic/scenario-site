# Complément phase 10 — Commentaires et premières pages

## Protocole et protection

La première page est la page de garde existante : douze champs et état masqué.
Pas de nouveau éditeur multipage arbitraire. Les commentaires comprennent fils,
réponses, résolution et ancre. Projets privés : sauvegarde complète v6 inchangée.
Projets partagés : GET/POST `/v10/projects/:scenarioId/metadata`, contrat distinct
`2026-09-v10`, copié à l'identique dans l'application. Contrats publics v1–v9 et
seize migrations précédentes inchangés (contrôles SHA-256).

Authentification et réautorisation à chaque lecture/écriture/replay : droits
cloud/versions/Studio, appareil actif, version minimale, membership et scénario
non supprimé. Owner/editor écrivent ; viewer consulte. L'acteur vient de la
session, pas du corps. Rate limiter distribué et CORS existants. Aucun cache ne
fait autorité. Aucun prix, secret, droit ou quota commercial décidé par le client.

Registres par champ (`title`, `cover.*`) ou fil (`comment:<id>`) avec révision
attendue. La RPC verrouille le Studio et la projection. Une commande applique
tous ses champs ou aucun. Champs/fils distincts fusionnent ; même champ/fil
concurrent = conflit explicite. Pas de fusion caractère par caractère ni de
fusion automatique de deux réponses simultanées au même fil.

UUID de commande lié au compte, scénario et SHA-256 canonique du corps. Timeout :
retry identique, puis envoi séparé des nouvelles éditions. Replay toujours soumis
à l'autorisation actuelle. Suppression = tombstone révisionné sans purge
automatique ; une ancienne copie ne peut pas ressusciter un fil supprimé.

Initialisation depuis le fichier cloud autorisé, taille/SHA-256 vérifiés par le
Worker ; aucun seed client. La RPC vérifie que la version source reste courante.
Ancien fichier malformé : erreur de récupération, jamais suppression silencieuse.

Migration `20260924000000_project_metadata.sql` : projection, opérations immuables,
captures immuables. RLS sur trois tables, aucun accès direct anon/authenticated,
RPC service_role seulement. Les valeurs sont des données privées du projet en
base ; les logs ne contiennent que route normalisée, résultats, compteurs et
request_id, jamais `registers`, `changes`, `response` ou texte de commentaire.

## Snapshots et pannes

La compaction v8 fige une capture v10 par snapshotId avant écriture de l'objet.
Un retry reprend la même capture même si les métadonnées ont changé. Le fichier
persistant comprend texte, page de garde, commentaires et projectMetadataRevision,
avec parent et checksum v6 immuables. Panne stockage/commit : capture récupérable,
ancien snapshot inchangé. L'ouverture charge la projection courante ; télécharger
une ancienne version conserve son état historique, sans commentaires futurs.

Client : envoi après 800 ms sans modification, polling 4 s, retry réseau après
30 s ; ce n'est pas une diffusion WebSocket des annotations. Fermeture/déconnexion
annule requêtes et timers. Conflit/révocation verrouille l'édition ; copie complète
récupérable dans Projets cloud. Après rechargement, aucune ancienne copie non
synchronisée n'est rejouée aveuglément. IndexedDB conserve le fichier par compte/
projet, sans token, commande, ticket ni URL temporaire. Aucun contenu cloud dans
localStorage. Le cache n'est pas chiffré contre l'utilisateur local et disparaît
si le profil navigateur est effacé. Un export indépendant reste recommandé.

Les marques de commentaire sont une projection exclue du diff v8 et de l'undo.
Les nouveaux IDs utilisent UUID. Une ancre est résolue dans son bloc ; citation
absente/ambiguë = « Passage introuvable », fil conservé et visible dans le panneau.
Modifier le premier message conserve ses réponses. Une mise à jour distante
n'efface pas un brouillon ouvert ; un conflit bloque son enregistrement.

Bornes techniques (pas des quotas commerciaux) : 32 changements/commande,
128 KiB de corps, 512 registres dont tombstones et 512 KiB de projection,
64 KiB/fil, 100 messages/fil, 16 384 caractères/message ou citation,
4 096/champ de garde, RPC 8 s, fichier/snapshot 4 MiB. Dépassement : export/
récupération explicite, sans troncature. Les bornes SQL sur JSONB textuel incluent
les espaces et peuvent refuser légèrement avant les bornes JSON du client.

## Exploitation

Surveiller route `/v10/projects/:id/metadata`, taux 5xx, latence et
`cloud=conflict`. Investiguer si 5xx > 1 % sur 5 min ou p95 > 2 s. Corréler
uniquement par request_id et identifiants autorisés ; jamais exporter les corps
privés vers la télémétrie. Révoquer par les routes existantes, ne pas modifier
l'historique. Une panne de présence/canal texte n'autorise jamais une requête.
Conflit : exporter la copie complète, charger le cloud puis réintroduire
volontairement le travail retenu. Ne jamais purger les tombstones pour forcer.

## Validations avant déploiement

128 tests API/contrats/migrations et 116 tests application réussis. Edge isolé,
trois comptes : couverture concurrente, viewer, commentaire/réponse/édition,
résolution/réouverture, ancre perdue, suppression et confidentialité localStorage.
Le navigateur intercepte l'API vers le Worker local : ce n'est pas une preuve
hébergée. SQL réellement exécuté sur préproduction dans BEGIN/ROLLBACK : trois
comptes, CAS, replay, snapshot figé, tombstones, immutabilité, RLS, révocation.
Rien du fixture SQL ne persiste. Premier essai rejeté puis correction du nombre
de propriétés d'ancre (six), puis réussite. Les essais échoués ne sont pas comptés.
Builds, typechecks, lint ciblé, scans de secrets et Worker à blanc réussis.
Rust : 3 tests réussis, 1 test de coffre natif ignoré par défaut. Avertissements
existants de taille des bundles et du linker. Pas de build d'installateur signé.

Commandes plateforme :

```powershell
npm.cmd run typecheck
node --experimental-transform-types --test --test-reporter=spec worker/tests/*.test.ts tests/*.test.ts
node --experimental-transform-types --test worker/tests/project-metadata.test.ts
npm.cmd run test:security
node scripts/security-check.mjs --app
npm.cmd run build
.\node_modules\.bin\oxlint.cmd worker/src/projectMetadata.ts worker/src/localRuntime.ts worker/src/worker.ts worker/src/collaborationLedger.ts worker/src/index.ts worker/src/types.ts worker/src/observability.ts worker/tests/project-metadata.test.ts worker/tests/metadataFixture.ts tests/project-metadata-migrations.test.ts lib/commercial/contracts-v10.ts scripts/validate-hosted-project-metadata.mjs
.\node_modules\.bin\wrangler.cmd deploy --dry-run --config wrangler.preproduction.toml
.\node_modules\.bin\supabase.cmd db query --linked --file outputs/project-metadata-transaction.sql
git diff --check
```

Le fichier de transaction assemble BEGIN, migration candidate, fixture
`supabase/tests/project_metadata_transaction.sql`, ROLLBACK. Après installation,
retester avec BEGIN + fixture seulement + ROLLBACK. Jamais supabase db push.

Après migration/déploiement, validation hébergée prévue :
`node scripts/validate-hosted-project-metadata.mjs --execute`. Le script refuse
tout autre Supabase que zblnsdyaoljnezxdidtx, utilise les trois comptes synthétiques,
crée son propre projet, vérifie stockage privé/checksums puis le place en corbeille
et ferme les sessions. Aucun paiement ni appel IA. Résultat à consigner après
exécution ; ne pas le présumer à partir des tests locaux.
