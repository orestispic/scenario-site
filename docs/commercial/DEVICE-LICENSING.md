# Licences et activation cryptographique

## Autorité et conservation des projets

Le serveur reste l’unique autorité sur l’offre, le paiement, les droits, les appareils et les révocations. Le client ne déduit jamais un droit payant d’une préférence locale. Une expiration, une révocation, un remboursement ou un chargeback modifie seulement l’autorisation commerciale : aucun document local, scénario cloud, historique ou export utilisateur n’est supprimé.

## Identité d’installation

Chaque installation génère une paire ECDSA P-256. La clé privée est non exportable dans le navigateur et conservée dans le coffre du système pour Tauri (Gestionnaire d’identifiants Windows ou Trousseau macOS). Le serveur ne reçoit que la JWK publique et son empreinte RFC 7638.

L’activation suit un challenge court, lié au compte et à l’usage demandé. Le challenge est consommé atomiquement et une seule fois avant vérification de la signature. L’activation SQL sérialise les demandes d’un même compte et impose au plus deux appareils payants, y compris lors de demandes concurrentes. Copier un identifiant matériel ne permet pas de remplacer une clé déjà liée.

Les routes cloud sensibles sont liées à l’appareil par une signature couvrant méthode, chemin complet, horodatage, nonce et empreinte exacte du corps. Une session valide reste nécessaire : la preuve appareil ne remplace pas l’authentification du compte.

## Licence hors ligne

`POST /v2/licenses/renew` exige un appareil actif et une nouvelle preuve de challenge. La licence ES256 contient notamment le compte, l’appareil, l’empreinte de clé, le plan, les droits, l’identifiant unique de licence et ses bornes temporelles. La durée est limitée à 30 jours et ne dépasse jamais la fin de la période payée.

Le client vérifie la signature, le `keyId`, l’intégrité du snapshot, l’appareil, l’expiration et l’horloge avant d’activer un droit payant hors ligne. Une copie du cache sur une autre installation échoue fermement. Une tolérance de cinq minutes évite les faux positifs, puis un recul d’horloge exige une reconnexion.

## Rotation des clés

1. Générer une nouvelle paire P-256 dans le gestionnaire de secrets.
2. Changer `OFFLINE_GRANT_KEY_ID` et `OFFLINE_GRANT_PRIVATE_JWK` ensemble.
3. Ajouter l’ancienne clé publique dans `OFFLINE_GRANT_PREVIOUS_PUBLIC_JWKS` sous son ancien identifiant.
4. Déployer le Worker et vérifier que `/v1/config` expose les deux clés publiques, jamais les clés privées.
5. Retirer l’ancienne clé seulement après expiration de la dernière licence correspondante (au moins 30 jours après la dernière émission).

## Ordre de mise en service en préproduction

1. Vérifier `supabase migration list --linked` et confirmer que seules les migrations attendues sont absentes.
2. Appliquer les migrations avec `supabase migration up --linked` sur le projet de préproduction explicitement choisi. Ne pas utiliser `db push`.
3. Exécuter le lint SQL distant et les tests transactionnels.
4. Compiler le Worker avec `wrangler deploy --dry-run`.
5. Déployer le Worker de préproduction, puis le client correspondant.
6. Tester avec deux comptes et trois installations : deux activations acceptées, la troisième refusée, révocation puis réactivation, renouvellement hors ligne, remboursement et chargeback Stripe test.

Les migrations et le Worker ne doivent jamais être publiés en production par déduction ou par réutilisation d’une configuration de test.
