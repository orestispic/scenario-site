# Contrat API futur — version 1

Base proposée : `/api/v1`. Toutes les réponses utilisent JSON UTF-8 avec `request_id`. Les routes authentifiées exigent une session valide et renvoient des erreurs `{ code, message, request_id }`; les corps entrants sont validés côté serveur. Ce contrat est une spécification, pas une API active.

La définition TypeScript de phase 1 est `lib/commercial/contracts.ts`, version `2026-09-v1`. Elle est maintenue en miroir du client car les deux dépôts restent indépendants ; toute évolution doit modifier les deux définitions dans le même changement coordonné. La route de lecture ajoutée pour l’interface de développement est `GET /me/account-overview` : identité, instantané de droits et règle de compatibilité, sans données de paiement.

La phase 2 conserve ce fichier v1 intact et ajoute `lib/commercial/contracts-v2.ts`, version `2026-09-v2`. Le Worker implémente les routes exactes `/v1/config`, `/v1/me`, `/v1/entitlements`, `/v1/devices`, `/v1/devices/activate`, `/v1/devices/deactivate`, `/v1/usage` et `/v1/auth/logout`. L’ancien agrégat `/api/v1/me/account-overview` reste une spécification de phase 1, non exposée par le Worker v2.

La phase 3 ajoute `lib/commercial/contracts-v3.ts`, version `2026-09-v3`, sans modifier v1/v2. Elle expose `/v2/billing`, `/v2/checkout/sessions`, `/v2/billing/portal-sessions`, `/v2/stripe/webhook`, `/v2/activation-keys/status`, `/v2/activation-keys/redeem` et `/v2/activation-keys/revoke`. Les choix clients se limitent à un identifiant de sélection opaque validé contre la configuration serveur; aucun droit, quota, rôle, limite ou identifiant Stripe n’est accepté du client.

| Domaine | Route et méthode | Intention | Autorisation |
| --- | --- | --- | --- |
| Authentification | `POST /auth/register`, `/auth/login`, `/auth/logout`, `/auth/password/reset/request`, `/auth/password/reset/confirm` | Compte et session | Publique avec rate limit, sauf logout. |
| Profil | `GET/PATCH /me` | Profil, consentements et préférences | Session. |
| Offres | `GET /configuration/offers`, `GET /configuration/client-compatibility` | Catalogue versionné, prix et minimum client | Public cacheable/contrôlé. |
| Droits | `GET /me/entitlements`, `POST /me/entitlements/refresh` | Instantané de droits, expiration hors ligne | Session + appareil reconnu. |
| Facturation | `POST /billing/checkout`, `POST /billing/portal`, `POST /webhooks/stripe` | Future souscription, portail, webhook | Session ; webhook signé Stripe. |
| Licence | `POST /licenses/activate`, `GET /licenses/devices`, `DELETE /licenses/devices/:id` | Activation, liste/révocation appareils | Session + quota appareil. |
| IA | `POST /ai/actions`, `POST /ai/pdf-imports`, `GET /ai/usage` | Travail IA et relevé du quota | Session + entitlement + rate limit. |
| Cloud | `GET/POST /scenarios`, `GET/PUT /scenarios/:id`, `POST /scenarios/:id/versions` | Synchronisation et versions append-only | Studio + ACL. |
| Studio | `GET /scenarios/:id/compare`, `POST /scenarios/:id/restore`, `POST /shares` | Comparaison, restauration, partage lecture | Studio + ACL. |
| Instagram | `GET/POST /instagram/drafts`, `GET/POST /instagram/schedule`, `GET /instagram/analytics`, `GET /instagram/connection` | Centre privé futur | Entitlement + rôle ; Meta serveur futur. |
| Administration | `/admin/configuration/*`, `/admin/offers/*`, `/admin/promotions/*` | Édition versionnée, jamais destructive | Rôle admin privé, audit obligatoire. |

## Concurrence, cache et compatibilité

Les lectures de configuration utilisent `ETag` et `Cache-Control`; le client envoie `If-None-Match`. `GET /me/entitlements` retourne `configuration_version`, `entitlement_snapshot_id`, `offline_valid_until`, `minimum_supported_version` et `server_time`. Les écritures de synchronisation exigent un `Idempotency-Key` et une version de scénario parente pour détecter un conflit.

## Principes de réponse

- Les quotas et droits sont évalués côté serveur juste avant une action facturable.
- `409` indique un conflit de version ; aucune version existante n’est écrasée.
- `426` indique qu’une version client est devenue insuffisante.
- Les exports/téléchargements utilisent des URLs signées de courte durée plutôt qu’un accès direct au bucket.
- Une route future de webhook est isolée de l’auth utilisateur, valide signature, horodatage, idempotence et journal d’audit avant effet métier.
