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
