# Phase 2 — authentification, API et RLS

## Ce qui fonctionne localement

- Le Worker `worker/src/local-test.ts` expose les huit routes `/v1` avec trois identités isolées : `discovery`, `author` et `studio`.
- Le point d’entrée de production `worker/src/index.ts` ne référence jamais l’adaptateur local et refuse l’environnement `test`.
- Les limites d’appareils et les droits sont évalués dans le dépôt serveur. Les corps API sont stricts : un client ne peut envoyer ni offre, ni droit, ni rôle.
- Le cache hors ligne est signé par ECDSA P-256 côté serveur. Le client vérifie la clé publique, l’identifiant de clé, la signature, l’instantané et l’expiration avant stockage.
- L’espace client web et le panneau Compte Tauri préparent connexion, inscription, récupération et déconnexion. Les jetons de cette phase restent en mémoire ; aucun jeton n’est enregistré dans `localStorage`.

## Démarrage local

Les dépendances existantes doivent être installées avec `npm.cmd ci` dans chaque worktree. Dans `scenario-site-commercial` :

```powershell
npm.cmd run start:api:local
```

Le Worker local répond par défaut sur `http://127.0.0.1:8787`. Pour le site, lancer un second terminal sans créer de fichier `.env` :

```powershell
$env:NEXT_PUBLIC_SCENARIO_AUTH_MODE='local-test'
$env:NEXT_PUBLIC_SCENARIO_API_BASE_URL='http://127.0.0.1:8787'
npm.cmd run dev
```

Pour l’application, utiliser au lancement local :

```powershell
$env:VITE_SCENARIO_AUTH_MODE='local-test'
$env:VITE_SCENARIO_API_BASE_URL='http://127.0.0.1:8787'
npm.cmd run dev
```

Le mode local n’accepte aucun mot de passe fixe : l’en-tête `local-test:<profil>` sert uniquement de sélection d’identité dans le point d’entrée local, absent du graphe d’imports de production.

## Connexion future à Supabase

1. Créer des projets Supabase séparés pour test, préproduction et production.
2. Appliquer les migrations dans l’ordre avec `supabase db reset` en local puis `supabase db push` seulement vers l’environnement explicitement choisi.
3. Configurer les URLs de redirection d’inscription/récupération et activer la politique de mot de passe retenue.
4. Fournir au navigateur uniquement l’URL et la clé anon/publishable. Fournir au Worker, via secrets Cloudflare, la clé `service_role`, le pepper d’appareil et la clé privée P-256.
5. Générer un couple P-256 par environnement ; publier seulement le JWK public via `/v1/config`. Conserver les anciennes clés publiques pendant la durée maximale des caches signés lors d’une rotation.
6. Vérifier les JWT via le JWKS Supabase, l’issuer, l’audience, `exp` et `nbf` avant toute lecture base.

## Frontière service-role

| Action | Client Supabase direct | API Worker service-role |
| --- | --- | --- |
| Lire son profil, abonnement, droits, appareils et usage | Lecture RLS limitée au propriétaire | Oui |
| Modifier son nom affiché | Colonne `display_name` seulement | Oui, audit si support |
| Créer/modifier offre, prix, quota, abonnement ou droit | Jamais | Oui, par route privée future et audit |
| Activer/révoquer un appareil | Jamais | Oui, RPC atomique et limite serveur |
| Écrire usage IA, clé d’activation ou audit | Jamais | Oui |
| Accéder au contenu d’un autre utilisateur | Jamais | Support/admin futur, action explicite et auditée |

Les rôles `support` et `admin` sont des données de profil. Ils ne sont jamais lus depuis une valeur fournie par le client et aucune route administrative n’est ouverte en phase 2.

## Validation RLS

Docker et Supabase CLI n’étaient pas disponibles pendant cette phase. `npm.cmd run test:api` exécute donc un contrôle déterministe qui exige RLS sur toutes les tables utilisateur, les politiques de lecture propriétaire et l’absence de droits directs de mutation commerciale.

Quand Supabase local sera disponible, exécuter :

```powershell
supabase start
supabase db reset
npm.cmd run test:api
```

Puis compléter par des tests SQL avec des JWT distincts : propriétaire, autre utilisateur, support et service-role. Les cas obligatoires sont lecture croisée refusée, élévation de rôle refusée, écriture de droits refusée, activation atomique à la limite et journal d’audit non modifiable.

## Simulé et prêt à connecter

Simulé : utilisateurs locaux, instantanés de droits locaux, stockage en mémoire, quotas locaux vides et clé de cache éphémère. Prêt à connecter : validation JWT/JWKS, accès REST service-role, RPC d’appareil, contrats `/v1`, CORS, erreurs, identifiants de requête, rate limit par instance, signature et vérification du cache.

Avant production, remplacer le rate limit mémoire par un service distribué Cloudflare et ajouter un stockage sécurisé Tauri pour le refresh token.
