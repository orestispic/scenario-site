# Versions nommées des projets — v14

Chaque projet conserve son identifiant public. `project_branches` associe chaque
version nommée à un scénario de stockage et un canal collaboratif indépendants.
La version initiale conserve les identifiants historiques : aucune donnée
existante n'est réécrite par la migration.

`GET /v14/projects/:id/versions` liste les versions. `POST` accepte une commande
strictement validée : `duplicate`, `blank`, `rename`, `delete`, `restore`.
Les droits proviennent du projet parent et sont vérifiés côté serveur à chaque
accès. Le lecteur peut consulter ; l'éditeur peut créer/renommer ; seul le
propriétaire peut supprimer/restaurer. La dernière version reste protégée.

La duplication est matérialisée par le Worker depuis le fichier vérifié, le
journal de texte persistant et les registres de commentaires/premières pages.
Une comparaison transactionnelle refuse une source qui a changé entre lecture
et écriture. La commande idempotente et les nouveaux objets de stockage évitent
les écrasements. Une suppression conserve intégralement le contenu récupérable.
Les objets non référencés après échec de transaction ne sont pas réutilisés.

Les snapshots automatiques restent distincts des versions nommées. Un export
de la copie courante exporte cette version uniquement. L'import d'un fichier
local multiversion reste refusé explicitement ; il n'est jamais aplati.

## Vérifications

- `node scripts/test-project-branches-sql.mjs` : toutes les migrations dans
  PostgreSQL isolé, puis transactions métadonnées et versions annulées.
- `npm run test:api` et `npm run typecheck`.
- `node scripts/validate-hosted-project-branches.mjs --execute` : exclusivement
  les comptes synthétiques de préproduction, projets de test placés ensuite
  dans la corbeille et sessions de test fermées. Aucune donnée utilisateur réelle.

Migration autorisée : `20260927000000_named_project_versions.sql`, uniquement
Supabase `zblnsdyaoljnezxdidtx`. Worker cible :
`scenario-commercial-api-preproduction`. Le résultat hébergé sera consigné après
exécution, sans considérer les seuls tests simulés comme une validation réelle.
