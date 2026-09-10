# Reprise — phase 1 commerciale

## État livré par les phases 0 et 1

Cette branche `codex/commercial-platform` dérive de `scenario-site/main`. Les fichiers ajoutés sont la préparation commerciale, le schéma SQL initial, `.env.example` et le contrat TypeScript serveur `lib/commercial/contracts.ts`; les parcours du site existant ne sont pas modifiés. La branche `codex/commercial-v1` contient l’adaptateur API injecté, un faux serveur de développement, le cache d’entitlements et l’interface de compte/licence en lecture seule.

Lire dans cet ordre :

1. `01-OFFRES-REFERENCE.md` — source de vérité fonctionnelle.
2. `00-ARCHITECTURE-CIBLE.md` — frontières produit et responsabilités.
3. `02-CONTRAT-API.md` et `03-SECURITE-EXPLOITATION.md` — règles serveur.
4. `supabase/migrations/20260910000000_commercial_foundation.sql` — modèle relationnel initial.
5. `04-PLAN-DEVELOPPEMENT.md` — tranche à réaliser et critères de sortie.

## Prompt conseillé pour la phase 1

```text
Réalise uniquement la phase 1 du projet commercial Scénario dans les worktrees commerciaux existants. Ne modifie jamais les worktrees source ni leurs branches main, ne pousse ni ne déploie. À partir de la documentation de phase 0, crée les contrats TypeScript partagés nécessaires à l’API, un adaptateur API injectable, un cache local versionné d’entitlements avec tolérance hors ligne configurable, et une interface de compte/licence en lecture seule alimentée par un faux serveur de développement. Ne code aucun prix, quota, droit, limite d’appareils ou secret dans le client. Ajoute les tests unitaires des contrats, de l’expiration du cache et de la version minimale, vérifie les builds, documente les choix et committe localement chaque worktree modifié.
```
