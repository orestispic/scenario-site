# Phase 9 — préproduction réelle et bêta privée

## Objectif et état de lancement

La phase 9 transforme les validations locales des phases 0 à 8 en validation intégrée sur des ressources de test isolées. Elle n'ajoute aucun prix, quota, droit ou comportement décidé par le client. Elle ne modifie aucun contrat public v1 à v8 et n'autorise ni production, ni paiement réel, ni appel IA payant implicite.

Le lancement local est fonctionnel : `npm.cmd run phase9:preflight` vérifie la préparation Supabase, Stripe test, signature hors ligne, secrets techniques, origines privées et canal Studio. Le contrôle ne contacte aucun fournisseur, ne déploie rien et n'affiche jamais les valeurs. Son code de sortie est `2` tant qu'une dépendance externe manque.

## Ordre de validation

1. Réserver un projet Supabase de test vide et conserver son URL, sa clé publique et sa clé secrète serveur hors Git. Le format `sb_secret_…` est préféré ; le JWT `service_role` historique reste accepté uniquement pendant la transition.
2. Réserver un environnement Cloudflare de test sans route publique, puis créer le Durable Object Studio et sa liaison `STUDIO_REALTIME_CHANNEL`.
3. Fournir des identifiants Stripe exclusivement test (`sk_test_…`, `whsec_…`). Aucun paiement réel n'est accepté par le Worker.
4. Générer une paire JWK P-256 et sept peppers distincts dans le coffre de secrets de test.
5. Remplacer les domaines `.invalid` des configurations app/API par les domaines HTTPS de test convenus.
6. Faire passer les préflights client et serveur avant toute commande distante.
7. Rejouer les migrations sur le projet de test seulement après confirmation explicite de son identité. Ne jamais utiliser `supabase db push` dans ce flux.
8. Exécuter les parcours avec trois comptes synthétiques : owner, editor, viewer ; vérifier aussi les révocations en cours de connexion et le replay des webhooks Stripe test.

## Fichier local attendu

Copier `.env.example` vers `.env.phase9.local`, compléter uniquement avec les valeurs de test et ne jamais committer ce fichier. Vérifier ensuite :

```powershell
npm.cmd run phase9:preflight
```

Le préflight indique seulement les catégories manquantes. Il n'imprime ni clé, ni JWK, ni pepper. Une configuration IA peut être vérifiée sans déclencher d'appel ; tout appel externe reste soumis à une autorisation distincte.

## Blocages constatés au lancement

Au lancement de la phase, aucune variable Supabase, Stripe ou Cloudflare n'est fournie. `wrangler.preproduction.toml` conserve volontairement ses domaines `.invalid` et ne déclare pas encore `STUDIO_REALTIME_CHANNEL`. La validation distante, le stockage objet partagé, le Durable Object réel, l'invalidation push, Stripe CLI et la bêta multi-machine ne sont donc pas présentés comme exécutés.

Les validations locales des phases précédentes restent acquises ; elles ne remplacent pas les contrôles externes de cette phase.

## Compatibilité des clés Supabase actuelles

Le Worker accepte `SUPABASE_SECRET_KEY` et conserve temporairement `SUPABASE_SERVICE_ROLE_KEY` pour les environnements historiques. Une clé `sb_secret_…` est envoyée uniquement dans l'en-tête `apikey` : elle n'est jamais traitée comme un jeton Bearer. Le client continue d'utiliser exclusivement la clé publique et les sessions utilisateur ; aucune clé serveur ne peut être intégrée au bundle ou au stockage local.

## Canal Cloudflare de préproduction

`StudioRealtimeChannel` implémente désormais le protocole interne `x-command` derrière une liaison Durable Object privée. L'API principale authentifie et réautorise chaque requête avant de transmettre au canal uniquement le profil, le Studio, le scénario et le rôle déjà validés. Le canal refuse toute commande métier sans cette autorisation bornée.

Les tickets ne sont conservés que sous forme SHA-256 et restent à usage unique. Les connexions et la présence sont éphémères ; elles ne sont jamais écrites dans le stockage durable. Les opérations, conflits, tombstones et snapshots bornés survivent en revanche au remplacement d'un isolate afin de permettre une reprise déterministe du canal de test. Cette persistance de transport ne remplace pas le journal Supabase append-only de phase 8 : les migrations distantes et la réconciliation intégrée doivent réussir avant d'ouvrir la bêta.

La configuration préproduction déclare la classe et sa migration Durable Object. Après autorisation de mise en service, `workers_dev` est activé pour l'unique Worker de test ; les URL de preview et toute route de production personnalisée restent désactivées. Les origines CORS sont limitées aux deux origines Vite locales et aux origines Tauri prévues.

## Validation externe contrôlée du 12 septembre 2026

Après autorisation explicite, un projet Supabase de test isolé a été lié et les onze migrations versionnées ont été appliquées avec `supabase migration up --linked`. `supabase migration list --linked` confirme une correspondance complète des versions locales et distantes. Le lint PostgreSQL hébergé ne remonte aucune erreur ; ses seuls avertissements concernent des paramètres conservés volontairement dans les RPC Studio pour préserver leurs signatures publiques.

Les cinq suites pgTAP s'exécutent aussi sur le projet lié : 75 assertions couvrant RLS, quotas IA, synchronisation cloud, Studio et collaboration temps réel passent avec succès. Chaque suite force le rôle `postgres` uniquement dans sa transaction et termine par `rollback`, car le rôle de connexion temporaire de la CLI n'a pas `USAGE` sur le schéma hébergé `extensions`. Aucun privilège ni jeu de données de test ne persiste.

Après une autorisation distincte, le Worker `scenario-commercial-api-preproduction` et ses deux classes Durable Object SQLite ont été créés sur Cloudflare. Treize valeurs Supabase, peppers et clés P-256 ont été générées ou transférées directement vers le coffre chiffré Cloudflare sans être affichées ni ajoutées à Git.

Le bucket Supabase `scenario-documents-preproduction` a ensuite été créé par l'API d'administration et relu pour validation. Il est privé, limité à 4 194 304 octets par objet et n'accepte que le MIME `application/vnd.scenario+json`, conformément aux bornes du Worker. Aucun document utilisateur ni fixture n'y a été téléversé pendant cette validation.

L'API de test est maintenant publiée sur `https://scenario-commercial-api-preproduction.ore-picard.workers.dev`. Le contrôle distant confirme `/v1/config` en HTTP 200, l'environnement `staging`, l'origine CORS locale exacte, un `request_id` sur chaque réponse et `/v1/me` en HTTP 401 sans session. L'adaptateur Supabase détache explicitement `fetch` pour le runtime Cloudflare, normalise l'URL hébergée et journalise les échecs par table/statut sans corps ni secret. La requête publique d'offres ne traverse que des clés étrangères réellement déclarées.

La migration append-only `20260918000000_initial_commercial_catalog.sql`, appliquée séparément après confirmation explicite du projet, publie la version serveur `1` du catalogue de référence. Elle crée trois offres et cinq sélections, leurs droits, leurs quotas distincts et les règles Windows/macOS exigeant au minimum la version `0.1.7`. Les montants et règles viennent de `01-OFFRES-REFERENCE.md`, restent absents du client et ne contiennent encore aucun identifiant Stripe. Une lecture réelle de `/v1/config` confirme la version `1`, cinq sélections et deux règles de compatibilité.

Trois comptes synthétiques owner/editor/viewer ont ensuite été créés par l'API d'administration Supabase, avec adresses confirmées sans envoi d'e-mail. Le script rejouable `phase9:accounts:provision` exige la référence exacte du projet, refuse d'écraser un compte existant et conserve les mots de passe uniquement dans `.env.phase9.accounts.local`, ignoré par Git. `phase9:accounts:validate` a vérifié pour chacun la connexion Supabase, la lecture de son profil `customer` par le Worker et la déconnexion immédiate sans afficher ni conserver les jetons. Cette validation a révélé puis permis de corriger l'appel lié du `fetch` natif lors de la lecture JWKS sur Cloudflare ; le test impose désormais un appel détaché compatible avec le runtime Worker.

Les mots owner/editor/viewer restent des identifiants de fixture, jamais des privilèges tirés des métadonnées Auth. Après autorisation, `phase9:studio:provision` a construit des snapshots `admin_grant` temporaires à partir du catalogue Studio actif lu dans Supabase : aucun droit, quota, limite ou prix n'est recopié dans le script. Les trois appareils synthétiques ont été activés, un scénario minimal a traversé le Worker et le bucket privé, puis « Studio de démonstration » a été créé par owner. Editor et viewer ont rejoint via les RPC d'invitation et d'acceptation ordinaires, sans notification externe.

Le contrôle rejouable `phase9:realtime:validate` est prêt à exercer le Durable Object hébergé avec ces trois sessions. Il exige l'URL `workers.dev` de test et l'identité exacte du projet Supabase, obtient trois tickets courts, vérifie leur usage unique, observe les trois rôles présents, soumet une opération synthétique sans texte utilisateur, rejoue cette opération sans doublon, refuse l'écriture viewer, contrôle un rattrapage à curseurs strictement croissants, puis ferme et reprend une connexion owner depuis son curseur. Toutes les connexions et sessions ouvertes par le contrôle sont fermées en sortie, y compris après une erreur ; aucun jeton, ticket ou contenu n'est imprimé ou écrit sur disque.

Sa première exécution distante a confirmé la création des connexions puis révélé que le pont Cloudflare remplaçait le code borné `collaboration_ticket_invalid` du Durable Object par le code générique `channel_unavailable`. Le pont conserve désormais les codes d'erreur internes strictement bornés et un test couvre le refus d'un ticket réutilisé. Après compilation à blanc et autorisation explicite, le correctif a été déployé sur la version Cloudflare `17c7dfeb-d7b7-4817-a7fe-ba8bf7f845b1`.

Le parcours hébergé complet passe ensuite avec la version cliente minimale `0.1.7` : présence simultanée owner/editor/viewer, refus du ticket réutilisé, opération synthétique rejouée sans double application, refus d'écriture viewer, rattrapage d'un événement à curseur monotone, fermeture puis reprise owner depuis le curseur. L'opération initiale apparaît comme rejouée parce qu'une exécution diagnostique précédente l'avait déjà appliquée avant de s'arrêter sur le contrôle du code viewer ; ce résultat confirme l'idempotence persistante attendue.

Le pont de réconciliation serveur vers les RPC Supabase de phase 8 est désormais implémenté pour les opérations et accusés de réception. Le canal applique d'abord l'opération ; Supabase l'inscrit ensuite dans son journal append-only. Une panne Supabase fait échouer la requête explicitement, tandis qu'un retry rejoue l'opération déjà présente dans le canal puis l'insère une seule fois par `operation_id` dans Supabase. Les curseurs du canal étant locaux au Studio et ceux de PostgreSQL globaux, les polls traduisent les identifiants d'opération effectivement reçus vers leurs curseurs persistés avant acquittement ; une opération absente fait échouer sûrement le poll jusqu'à sa réconciliation. Le contrôle hébergé vérifie directement l'unicité de l'opération et l'accusé dans la base, sans lire ni imprimer son contenu.

Après autorisation explicite, ce pont a été déployé sur la version Cloudflare `01103476-6a72-4745-80e9-f226a8e250b4`. Le parcours externe confirme une opération unique dans le journal Supabase, deux événements rattrapés dans l'ordre, l'accusé persistant et la reprise owner au curseur de canal `2`. Le contrat public v8 reste inchangé.

La prochaine tranche locale complète ce pont pour les snapshots et compactions. Le Durable Object conserve un artefact interne versionné contenant uniquement les mutations gagnantes et les identifiants d'opération ; cette commande privée n'est jamais exposée au client. Le Worker relit la version `.scenario` parente dans le bucket privé, applique les mutations de blocs de manière déterministe tout en conservant les autres métadonnées du document, écrit les nouveaux octets dans le stockage puis appelle une unique RPC SQL. La migration append-only `20260919000000_studio_snapshot_reconciliation.sql` lie atomiquement le même `snapshot_id` et le même `version_id` à la version cloud, au parent courant, au curseur PostgreSQL réconcilié, au checksum, à la clé objet et au `request_id`. Elle revalide le rôle owner/editor, les droits, l'appareil, la version cliente et le membership via `authorize_studio_operation`, verrouille le Studio et le scénario, borne l'objet à 4 Mio et réserve son exécution au `service_role`.

L'ordre de panne reste sûr : aucun enregistrement SQL n'est créé si l'upload échoue ; si SQL échoue après upload, le retry récupère le même artefact Durable Object, réécrit le même objet et rejoue les mêmes identifiants. Un objet orphelin peut subsister entre ces deux étapes et doit être supprimé uniquement par l'inventaire différentiel documenté en phase 8. Le poll refuse un événement `snapshot.created` qui n'existe pas encore dans Supabase. La présence, les tickets, les textes et les opérations brutes ne sont pas ajoutés aux logs.

Cette tranche est validée localement par 96 tests, dont le merge du document complet, l'ordre upload/RPC, la survie de l'artefact à un remplacement d'isolate, l'idempotence et les contrôles SQL statiques. Le build web, le typecheck, le lint ciblé, le format, la recherche de secrets et la compilation Worker à blanc passent. Le moteur Docker local n'étant plus disponible au moment de ce contrôle, la nouvelle migration n'est pas présentée comme exécutée sur PostgreSQL. Elle n'est pas encore appliquée au projet hébergé et le nouveau Worker n'est pas encore déployé : ces deux mutations exigent une autorisation explicite portant sur cette migration et sur le commit exact.

Le secret d'invitation Cloudflare a été tourné une fois, avant toute invitation persistante, puis conservé uniquement dans le fichier d'environnement local ignoré. Le parcours hébergé a été rejoué avec les mêmes clés d'idempotence : il n'a créé aucun doublon et les trois memberships sont restés owner/editor/viewer. Une tentative d'auto-élévation viewer et une requête cliente en version `0.1.6` ont été refusées. La correction d'appel détaché de `fetch`, révélée par JWKS, est maintenant partagée par tous les adaptateurs réseau afin de couvrir aussi base, stockage, Studio, quotas, Stripe et IA dans le runtime Cloudflare.

Stripe et l'IA restent fermés par des adaptateurs indisponibles sans accès réseau tant que leur configuration de test complète n'est pas fournie. L'API non payante peut ainsi démarrer sans clé factice ; l'environnement `production` conserve l'obligation stricte de configurer les deux fournisseurs. Restent bloqués avant une bêta fonctionnelle complète : application puis validation hébergée de la migration de snapshots, déploiement du Worker correspondant, Stripe exclusivement test, IA explicitement autorisée et validation multi-machine du canal temps réel. Aucun paiement, notification ou appel IA réel n'a été déclenché.
