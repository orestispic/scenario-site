# Architecture commerciale cible — Scénario

## But et limites de la phase 0

Scénario devient un seul produit Tauri Windows/macOS, complété par un site public, un espace client et une API serveur. Cette phase décrit l’architecture sans relier de compte externe, sans installer de nouvelle dépendance et sans publier de service.

## Vue d’ensemble

```text
Application Tauri (Windows/macOS)       Site public + espace client
  éditeur local, cache 7 jours              contenu, compte, facturation
              \                                  /
               \ HTTPS + sessions courtes       /
                API serveur Scénario
       auth | offres | droits | licences | IA | cloud | Studio | Instagram
                |                 |                  |
       Base PostgreSQL/Supabase   Stockage objets     Fournisseurs futurs
       migrations versionnées     scénarios/exports   Stripe, OpenAI, Meta
```

Le site et l’API peuvent débuter dans le dépôt `scenario-site-commercial` mais leurs responsabilités doivent rester séparables : routes web rendues pour le public/espace client, routes API validées côté serveur, migrations SQL dans `supabase/migrations`. L’application ne dépend d’aucun SDK fournisseur.

## Composants et responsabilités

| Composant | Responsabilité | Données sensibles autorisées |
| --- | --- | --- |
| Application Tauri | Écriture locale, UX, cache de droits et file de synchronisation | Jeton de session dans coffre-fort système ultérieur ; jamais de secret fournisseur. |
| Site | Pages publiques, tarifs issus de la configuration, espace client | Cookie de session `HttpOnly`; aucune clé serveur dans le navigateur. |
| API | Autorité des sessions, droits, quotas, licences, synchronisation, IA, Instagram | Secrets serveur via gestionnaire de secrets ultérieur. |
| PostgreSQL/Supabase | État relationnel, historique immuable, audit | Accès backend/service seulement pour les opérations privilégiées. |
| Stockage objet | Contenu cloud chiffrable ultérieurement, versions et exports | URL signées temporaires, contrôlées par l’API. |

## Comptes, sessions et mot de passe

L’API fournit inscription, vérification d’e-mail, connexion, renouvellement, déconnexion et réinitialisation de mot de passe. Une session est courte, renouvelable et révocable ; les cookies web sont `HttpOnly`, `Secure`, `SameSite=Lax` ou plus restrictif. L’application conserve un jeton de renouvellement uniquement dans le coffre-fort système futur. Les réponses d’authentification ne révèlent jamais si un e-mail existe.

## Abonnements, licences et appareils

Stripe sera le futur collecteur de paiement, mais seul un webhook Stripe vérifié créera ou modifiera un abonnement. L’API produit ensuite des instantanés de droits (`entitlement_snapshots`) à partir des achats et promotions figés. Une clé d’activation n’est jamais stockée en clair : seulement une empreinte salée/pepper côté serveur, avec affichage éventuel des derniers caractères et rate limit de tentative.

Chaque activation associe un appareil pseudonymisé à une licence selon la limite courante de droits. La révocation retire l’accès réseau futur ; elle n’efface pas de fichiers locaux. Le client peut conserver un instantané validé pendant 7 jours au maximum.

## Configuration centrale et historique immuable

Les offres, droits, quotas, périodes, monnaies, promotions et compatibilité sont publiés depuis `offer_configuration_versions` et `offer_configuration_items`. L’administration future crée une nouvelle version effective au lieu d’écraser l’ancienne. Chaque souscription pointe vers un `price_id`, et chaque attribution de droits référence un instantané : une modification future des prix ou de l’offre ne retire donc pas un droit acheté.

Les clients téléchargent la version actuelle avec un ETag/numéro de version et une date de cache. Le serveur impose aussi `minimum_supported_version` par plateforme et canal.

## IA, cloud et Studio

Les requêtes IA passent uniquement par l’API, qui authentifie, autorise, applique quota/rate limit, enregistre l’usage puis appelle OpenAI. Les imports PDF IA sont un compteur distinct. Les scénarios cloud utilisent un identifiant stable, des versions append-only, des révisions structurées/colourisées, restauration par création d’une nouvelle version et comparaison côté serveur/client à partir d’instantanés. Les fichiers FDX et Fountain, les cartes de scènes, rapports et partages de lecture sont des capacités Studio gouvernées par droits.

## Centre Instagram

Le centre privé gère calendrier, brouillons, demandes de publication programmée, statut et statistiques. Une future intégration Meta se fait exclusivement côté serveur après connexion officielle, avec jetons chiffrés, périmètres minimaux et audit. Aucune automatisation Instagram n’est activée à cette phase.

## Environnements

Préproduction privée : base, buckets, clés et webhooks séparés ; données synthétiques ; accès restreint ; aucune campagne publique. Production : ressources séparées, sauvegardes, surveillance, rotation de secrets et procédure de restauration testée. Aucun environnement réel n’est créé en phase 0.
