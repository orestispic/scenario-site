# Référence unique des offres commerciales

Ce document est la source de vérité fonctionnelle des offres. Les valeurs ci-dessous doivent être chargées depuis la configuration serveur versionnée ; elles ne doivent être recopiées ni dans le site ni dans l’application.

| Offre | Prix public TTC | Projets actifs | IA courtes/mois | Imports PDF IA/mois | Appareils | Cloud et Studio |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Découverte | Gratuit | 3 | 0 | 0 | 1 | Non |
| Auteur IA | 8,80 EUR/mois ou 88 EUR/an | Illimités | 600 | 3 | 2 | Non |
| Studio | 15 EUR/mois ou 150 EUR/an | Illimités | 2 000 | 15 | 3 | Oui |

## Droits inclus

| Droit | Découverte | Auteur IA | Studio |
| --- | --- | --- | --- |
| Édition locale | Oui | Oui | Oui |
| Projets illimités | Non | Oui | Oui |
| Actions IA courtes | Non | Oui, quota 600 | Oui, quota 2 000 |
| Imports PDF avec IA | Non | Oui, quota 3 | Oui, quota 15 |
| Appareils | 1 | 2 | 3 |
| Sauvegarde et synchronisation cloud | Non | Non | Oui |
| Versions, restauration, comparaison | Non | Non | Oui |
| Révision colorée, cartes de scènes, planification, rapports | Non | Non | Oui |
| Import/export FDX et Fountain professionnel | Non | Non | Oui |
| Partage de lecture | Non | Non | Oui |

## Règles de modélisation

- Le produit n’utilise pas les noms, tarifs ni quotas comme constantes client : il utilise des `offer_code`, `entitlement_code` et `quota_code` stables.
- Prix, devise, période, taxes affichées, promotion, période d’essai, limite d’appareils, période hors ligne et texte marketing sont des attributs de configuration versionnée.
- Les 7 jours de fonctionnement hors ligne pour les abonnés sont une valeur de configuration par offre/droit, pas une constante distribuée.
- Une promotion crée un prix ou une règle promotionnelle datée. Elle ne modifie jamais rétroactivement la facture ou l’instantané de droits d’un achat existant.
- Les droits achetés sont matérialisés dans un instantané append-only, avec date d’effet et provenance. Une réduction d’offre ultérieure s’applique seulement aux nouveaux instants définis explicitement.

## Codes initiaux proposés

`discovery`, `author_ai`, `studio` pour les offres ; `ai_short_action`, `ai_pdf_import`, `cloud_sync`, `scenario_versions`, `scenario_compare`, `colored_revision`, `scene_cards`, `planning_tools`, `reports`, `pro_formats`, `read_share`, `instagram_center` pour les droits. Ces codes peuvent évoluer par ajout/version, pas par réutilisation sémantique.
