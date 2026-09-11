# Phase 5 — IA serveur et quotas atomiques

## Périmètre et contrats

Cette phase ajoute l’IA commerciale côté serveur sans modifier les contrats v1 à v4. Le contrat miroir `2026-09-v5` définit trois routes authentifiées : `POST /v4/ai/actions`, `POST /v4/ai/pdf-imports` et `POST /v4/ai/reconcile`. Les actions courtes couvrent réécriture et traduction structurée ; l’import PDF reçoit uniquement le texte déjà extrait par l’application et renvoie le JSON de scénario. Les réponses exposent l’opération, l’état de réservation, une vue d’usage, le marqueur de rejeu et le `request_id` généré par le serveur.

Le client ne choisit ni fournisseur, ni modèle, ni droit, ni quota. Les droits `ai_short_action` et `ai_pdf_import`, leurs limites et leurs périodes sont copiés depuis la configuration commerciale serveur versionnée vers le snapshot effectif. Les deux compteurs restent indépendants. Les petites limites présentes dans `LocalTestRepository` sont exclusivement des fixtures déterministes de développement ; elles ne définissent aucune offre de production.

## Contrôles avant fournisseur

Chaque exécution passe successivement par CORS, limite de débit d’entrée, session authentifiée, profil serveur et limite distribuée par profil. La réservation SQL vérifie ensuite dans la même transaction la version minimale de la plateforme, l’appareil actif appartenant au profil, le snapshot de droits effectif, le droit demandé et le quota configuré. Le cache hors ligne n’intervient dans aucun de ces contrôles et ne peut jamais autoriser une opération IA.

Les corps JSON acceptent une liste fermée de champs. La clé `Idempotency-Key` est bornée à 16–128 caractères ; version, plateforme et empreinte d’appareil sont obligatoires. Les tailles des actions courtes, imports PDF et réponses, le nombre de segments et le timeout fournisseur sont bornés par configuration serveur. Une propriété cliente de rôle, offre, modèle, quota ou droit est refusée avant réservation.

## Réservation atomique et idempotence

La migration append-only `20260914000000_server_ai_quotas.sql` crée `ai_quota_reservations` et `ai_usage_events`. Une clé d’idempotence est HMACée avec le profil ; le contenu canonique reçoit une empreinte HMAC séparée. La base ne conserve donc ni clé brute, ni prompt, ni scénario. L’unicité `(user_id, idempotency_key_hash)` empêche un double débit ; une même clé avec un autre contenu retourne `ai_idempotency_conflict`. Un verrou transactionnel par profil/quota/période sérialise les réservations concurrentes. Les états qui consomment la capacité sont `reserved`, `succeeded` et `uncertain` ; `released` la rend disponible.

Cycle de vie :

1. `reserve_ai_quota` lie la demande au snapshot de droits, à la version de configuration, au quota, à la période et au `request_id`.
2. Après résultat fournisseur validé, `confirm_ai_quota` passe à `succeeded` et ajoute un événement d’usage immuable.
3. Une erreur certaine avant résultat passe à `released` ; l’appelant doit créer une nouvelle demande.
4. Timeout, panne réseau, 429/5xx fournisseur ou réponse inexploitable passent à `uncertain`. Cette capacité reste conservée pour empêcher une répétition potentiellement facturée.
5. `reconcile_ai_quota` relit seulement l’état du propriétaire par clé HMACée. Le serveur ne persiste pas le contenu de la réponse IA : un résultat perdu après succès n’est pas reconstituable, mais un retry ne redébite jamais.

Les événements d’usage sont append-only, liés à la réservation, au snapshot, à la version de configuration et au `request_id`. Leur trigger interdit UPDATE/DELETE. Les tables et RPC n’accordent aucune écriture à `authenticated`; seul `service_role` exécute les transitions. Le test local de concurrence et les assertions SQL statiques ne remplacent pas une exécution PostgreSQL/Supabase réelle.

## Fournisseurs et confidentialité

`AiProvider` est injectable. `DeterministicAiProvider`, chargé uniquement par `localRuntime`, produit des réponses reproductibles sans réseau. L’entrée serveur utilise `OpenAiResponsesProvider`; clé, modèles et timeout viennent uniquement des secrets/variables Worker. L’adaptateur appelle Responses avec `store: false`, formats structurés pour traduction/import, et métadonnées techniques limitées à `request_id` et opération. Aucun appel fournisseur réel n’a été lancé pendant cette phase.

Les logs applicatifs n’incluent ni corps, ni prompt, ni scénario, ni réponse, ni identifiant utilisateur, ni token, ni donnée de paiement. Ils ajoutent seulement l’issue IA parmi `succeeded`, `replayed`, `released`, `uncertain` à la liste fermée de dimensions déjà documentée en phase 4. Les métriques recommandées sont volume et latence par route/statut, ratios 401/403/426/429/5xx, quotas épuisés et réservations incertaines. Ne jamais utiliser `request_id` comme label à forte cardinalité.

Pour une réponse incertaine : rechercher le `request_id` sans copier le contenu, vérifier l’état fournisseur avec l’outillage autorisé, puis décider par une procédure opérateur future si la réservation doit être confirmée ou libérée. La phase 5 n’ajoute volontairement aucune mutation publique de réconciliation, afin d’éviter une double attribution. Un replay client ne fait que relire l’état.

## Configuration

La préproduction reste séparée. Elle requiert `OPENAI_API_KEY`, `OPENAI_SHORT_ACTION_MODEL`, `OPENAI_PDF_IMPORT_MODEL` et `AI_IDEMPOTENCY_PEPPER` dans le gestionnaire de secrets, ainsi que les variables techniques bornées présentes dans `wrangler.preproduction.toml`. Les placeholders `.invalid` restent inchangés et aucun secret n’est commité. Stripe continue de refuser toute clé autre que test ; aucune route IA ne contourne les règles Stripe/Supabase des phases antérieures.

## Validation locale

Depuis `scenario-site-commercial` :

```powershell
npm.cmd run test:api
npm.cmd run test:security
node scripts/security-check.mjs --app
npm.cmd run typecheck
npm.cmd run build
node scripts/check-phase5-style.mjs
node scripts/check-phase5-style.mjs --app
npm.cmd exec -- wrangler deploy --dry-run --config wrangler.preproduction.toml --outdir .wrangler/phase5-preproduction
npm.cmd exec -- wrangler deploy --dry-run --config wrangler.local-test.toml --outdir .wrangler/phase5-local
node scripts/test-local-runtime.mjs
git diff --check
```

Depuis `scenario-app-commercial` :

```powershell
npm.cmd test -- --run
npm.cmd run build
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
git diff --check
```

Les tests couvrent succès, quotas distincts et épuisés, concurrence, droits absents, appareil d’un tiers, version ancienne, idempotence, retry, erreur fournisseur certaine, résultat incertain et réconciliation, import PDF, session expirée, champs d’élévation et confidentialité des logs. Les compilations Wrangler sont obligatoirement à blanc et ne créent aucune ressource.

## Validations externes bloquées

Sur ce poste, les commandes Supabase CLI, Docker et Stripe CLI sont absentes, et aucune variable d’identification Supabase, Stripe ou OpenAI n’a été détectée. Aucune validation externe n’a donc été tentée.

Supabase CLI/Docker et une base locale jetable doivent être disponibles avant d’exécuter les migrations et pgTAP :

```powershell
supabase start
supabase db reset --local
supabase test db
```

`db reset --local` détruit la base locale : vérifier qu’elle est jetable et qu’aucun projet distant n’est lié. Ne jamais lancer `db push` dans cette phase. Valider alors la concurrence PostgreSQL avec deux sessions et confirmer RLS, privilèges RPC, snapshots et historique immuable.

Un essai OpenAI réel exige une clé et des modèles de développement déjà fournis, une préproduction isolée et une autorisation explicite d’appel potentiellement payant. Configurer les secrets hors dépôt, démarrer seulement le Worker préproduction local, puis soumettre une fixture synthétique sans scénario utilisateur. Vérifier `store=false`, limites, timeout, état de quota et absence de contenu dans les logs. Sans cette autorisation, conserver `DeterministicAiProvider`.

Stripe test et Supabase hébergé n’ont pas été rappelés : leurs validations externes de phase 4 restent attendues et ne sont pas prouvées par les fixtures locales.

## Références

- [OpenAI Responses API](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)
- `lib/commercial/contracts-v5.ts`
- `supabase/migrations/20260914000000_server_ai_quotas.sql`
- `worker/tests/phase5-ai.test.ts`
