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

## Déploiement et résultat du 14 septembre 2026

Supabase `zblnsdyaoljnezxdidtx` : migrations `20260927000000`,
`20260927100000`, `20260927200000` et `20260927300000` appliquées. La première a aussi été validée
sur le serveur dans une transaction entièrement annulée avant application.
Le premier essai hébergé a détecté une coercition JSON vers texte sur le chemin
de téléchargement ; la migration corrective conserve le contrat historique.
Le second correctif uniformise les verrous et interdit le partage autonome
d’un scénario interne. Le dernier sépare l’administration du projet de son
canal initial : supprimer Version 1 ne bloque pas la gestion des collaborateurs.
Aucune migration déjà appliquée n’a été modifiée.

Worker `scenario-commercial-api-preproduction` : contrat v14 déployé, commit
`8721855`, version Cloudflare `caa14f73-cf69-423a-b402-268ec2f78cc9`.
Validation réelle réussie avec Owner, Editor et Viewer : création vierge,
répétition idempotente, canaux indépendants, duplication du texte non compacté,
commentaires et couverture à jour, écritures concurrentes de métadonnées,
refus du lecteur, suppression/restauration et révocation héritée. Validation
hébergée v10/v8 existante également réussie (non-régression des snapshots).

172 tests serveur, typecheck, lint ciblé et contrôle de sécurité réussis.
Les projets synthétiques ont été placés dans la corbeille ; historique immuable
conservé, sessions de test fermées. L’installateur Windows n’est pas publié ici.
