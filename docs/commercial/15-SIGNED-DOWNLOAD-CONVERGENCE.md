# Téléchargements signés et convergence du client

Le test de chargement d'une base Studio avec les trois comptes réels a renvoyé
404 : `SupabaseScenarioObjectStorage.temporaryDownload` résolvait une URL relative
`/object/sign/...` contre la racine du projet, omettant `/storage/v1`.
La construction attendue est également couverte par les
[tests officiels Supabase Storage](https://github.com/supabase/storage-js/blob/main/test/storageFileApi.test.ts).

Le résolveur corrige le préfixe, accepte une URL déjà complète de la même origine
et refuse une autre origine, un autre objet, des credentials URL ou un token
manquant. Le token n'est ni affiché ni stocké. Les contrats publics et toutes les
migrations restent inchangés. Trois tests spécifiques couvrent ces invariants
et l'adaptateur de stockage complet.

Cette correction serveur est **locale, non déployée** : le dernier Worker hébergé
reste celui autorisé précédemment, `6ebd21c` / version
`bee273c7-bde7-4509-aa02-ee1a2cf7f016`. Le nouveau client supporte l'ancienne forme
d'URL de manière limitée et vérifie les octets par SHA-256, ce qui permet de tester
le parcours réel sans nouveau déploiement. Aucun `db push`, migration, push Git,
paiement, notification ou création de compte n'a été exécuté.

Validations locales :

```powershell
npm.cmd run test:api
npm.cmd run typecheck
.\node_modules\.bin\oxlint.cmd worker/src/cloudSync.ts worker/tests/storage-signed-url.test.ts
.\node_modules\.bin\wrangler.cmd deploy --dry-run --config wrangler.preproduction.toml
npm.cmd run test:security
node scripts/security-check.mjs --app
git diff --check
```

110 tests API réussis, TypeScript/lint/scans réussis ; compilation Worker à blanc
réussie (178,57 KiB). Les migrations historiques restent protégées par les tests
SHA-256 existants, sans application SQL supplémentaire.

Le worktree application documente la correction complète dans
`docs/commercial/12-DOCUMENT-CONVERGENCE.md` : base commune immuable, projection LWW,
transactions ProseMirror et sauvegarde locale avant de rejoindre. 96 tests client
et validation Edge des menus aux zooms 60/100/160 % réussis. La comparaison réelle
des documents reconstruits pour trois comptes **successifs** a réussi ; aucun
texte ajouté aux scénarios hébergés.

Le test simultané de 60 secondes incluant les trois lecteurs du diagnostic et les
onglets interactifs a rencontré deux 429 d'ingress. Il n'est pas présenté comme
un succès de stabilité. Le test séquentiel réduit la concurrence du diagnostic
sans modifier les limites du service. Avant une validation de charge/production,
dimensionner séparément l'ingress par IP et les limites authentifiées ; ce point
reste ouvert, ainsi que les limites de double écriture du journal déjà documentées.
