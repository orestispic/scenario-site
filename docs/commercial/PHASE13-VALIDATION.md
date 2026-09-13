# Phase 13 — validation de la bêta (13 septembre 2026)

## Vérifié

- 165 tests serveur réussis : réservation PostgreSQL, concurrence, quotas jour/mois,
  plafond monétaire, refus sans droits/appareil, idempotence, coupure et usage incertain,
  permissions SQL, validation des entrées et absence de capacités serveur dans le modèle.
- TypeScript, build du site et contrôle des secrets dans les sources réussis.
- Tests réels sur le Worker de préproduction avec le compte Owner synthétique :
  réécriture, traduction, import PDF, renvoi idempotent sans nouveau débit,
  refus des paramètres modèle/budget et d'un appareil inconnu.
- Usage authentifié disponible, usage anonyme et RPC SQL direct interdits.
- Défaut découvert et corrigé : l'import PDF pouvait renvoyer un JSON non compatible
  avec l'éditeur. Schéma strict de document/paragraphe/texte et validation serveur ajoutés.
- Worker validé : `2234440b-4678-4a51-a901-b69a8d842cce`.
- Usage Studio après les essais : 2,52 % journalier, 0,08 % mensuel.
  Les essais ont consommé des tokens du compte synthétique, sans changer ses quotas.

## Reproduire

- `npm run test:api`, `npm run typecheck`, `npm run test:security`, `npm run build`.
- `node scripts/verify-ai-tokens.mjs` : lecture des usages et refus d'accès.
- `node scripts/verify-ai-provider.mjs --all` : trois courtes générations réelles,
  contrôles de format, idempotence et refus de sécurité (consomme des tokens).
- Configuration des modèles et budgets : `config/ai-policy.json` et
  [procédure IA](AI-TOKEN-BUDGETS.md). Le client ne décide jamais du modèle ni des quotas.

## Limites de cette validation

La saturation est testée dans PostgreSQL embarqué, pas par épuisement volontaire
des budgets hébergés. L'interface est testée avec un navigateur isolé et un Worker
local simulé ; les appels fournisseur sont vérifiés séparément en préproduction.
Cela ne constitue ni un audit de sécurité indépendant, ni une garantie absolue.
Les essais manuels Windows (installation vierge, mise à jour depuis 0.1.8,
redémarrage hors connexion avec licence valide) restent à effectuer.
La signature Tauri des mises à jour ne remplace pas la signature Windows Authenticode.
Le paiement reste en mode Stripe test ; aucune ouverture commerciale réelle autorisée ici.
