# Phase 12 — dossier de mise en service, à exécuter avant ouverture

## État au 12 septembre 2026

senario.app est acheté. Identité publique vérifiée via l'API officielle de recherche
des entreprises : ORESTIS PICARD (ORESTIS PRODUCTION), SIRET 95295149900013, actif.
Aucune adresse personnelle recherchée ou copiée. Coordonnées professionnelles,
contact, fiscalité, médiateur et modalités commerciales restent à compléter.
`legal-review.json` conserve ces champs manquants sans inventer de valeur.
Les pages du site sont des informations provisoires de bêta, pas des CGV validées.

## 1. Messagerie et demandes des utilisateurs

1. `support@senario.app` est créée chez Zoho Mail et sa réception ainsi que son
   émission ont été vérifiées manuellement le 13 septembre 2026 avec une seconde
   boîte contrôlée.
2. MX, SPF et DKIM Zoho Europe sont validés. DMARC est publié en observation
   (`p=none`) avec rapports agrégés vers la boîte support ; le renforcer seulement
   après examen des rapports et inventaire de tous les expéditeurs légitimes.
3. Séparer la réception du support et le SMTP transactionnel si nécessaire.
   Enregistrer le secret SMTP uniquement dans Supabase Auth, jamais dans Vite.
4. Supabase Authentication : définir une Site URL détenue et validée, puis les
   modèles Confirm signup et Reset password depuis `release/emails/`. Le lien
   comporte TokenHash dans le fragment et non dans la requête. Désactiver le suivi
   des clics ; vérifier qu'aucun fournisseur ne réécrit le lien de manière sensible.
   En préproduction, chaque URL Vercel temporaire doit être explicitement ajoutée
   aux origines du Worker ; `senario.app` fournit l'origine stable prévue ensuite.
   Le 13 septembre 2026, le SMTP Zoho, la confirmation explicite, la récupération
   de mot de passe et la connexion suivante ont été validés de bout en bout avec
   `support@senario.app` sur la preview `5f9`, après correction de son origine CORS.
5. Avec deux boîtes contrôlées : inscription, confirmation explicite, double clic,
   lien consommé/expiré, récupération, mauvais destinataire, changement de mot de
   passe puis connexion avec le nouveau. Ne pas comptabiliser les tests interceptés
   comme des livraisons SMTP réelles. Les invitations Studio ont leur propre
   transport encore à activer et à vérifier : le modèle Auth ne le remplace pas.

Support : créer un ticket privé avec date, version, OS, catégorie et request_id
éventuel. Ne demander ni mot de passe, ni clé, ni texte de scénario. Pour un export
ou effacement : vérifier l'identité via le compte, inventorier propriété et rôles,
exporter les projets, transférer le dernier owner si besoin, distinguer suppression
active et expiration des sauvegardes, appliquer la politique de conservation
validée puis confirmer le résultat. Pas de suppression SQL improvisée. Cette
procédure reste manuelle ; aucun bouton d'effacement automatique n'a été ajouté.

## 2. Registre de données et projet de politiques

| Données | Utilisation | Service | Décision restante |
|---|---|---|---|
| Identité/e-mail/session | Connexion et sécurité | Supabase Auth | Base légale, durée, révocation globale |
| Scénarios, garde, commentaires, versions | Stockage et collaboration choisis | Supabase Storage/Postgres, Cloudflare DO | Régions, rétention, purge et export |
| Usage, droits, appareils | Autorisation et facturation | Supabase/Worker | Durées par finalité, obligations comptables |
| Références Stripe | Paiements test | Stripe | Régime fiscal et passage live séparé |
| Journaux techniques | Exploitation et abus | Cloudflare, Supabase, Vercel | Durée, accès, transferts et alertes |
| Opérations IA choisies | Aide à la rédaction | Fournisseur serveur à configurer | Sous-traitant, rétention et coût autorisé |

Avant vente, finaliser : identité/contact/hébergeur, objet du service, conditions
d'accès, propriété des textes, IA, prix et taxes, paiement, renouvellement,
résiliation, rétractation applicable au service numérique, garanties, réclamations,
médiation, changements de conditions, droit applicable. Ne pas inventer une
renonciation aux droits du consommateur. Le catalogue demeure côté serveur.
La CNIL demande une information précise sur finalités, bases légales, destinataires,
conservation et droits ; fixer ces choix avant d'approuver les pages.

Sources consultées :
- https://entreprendre.service-public.gouv.fr/vosdroits/F31228
- https://www.cnil.fr/fr/conformite-rgpd-information-des-personnes-et-transparence
- https://www.cnil.fr/fr/passer-laction/les-durees-de-conservation-des-donnees
- https://supabase.com/docs/guides/auth/auth-email-templates

## 3. Sauvegarde cohérente et restauration

Objectifs proposés, non mesurés : RPO 24 h, RTO 4 h. Désigner un responsable,
un emplacement hors site chiffré et une clé conservée séparément. Ne pas sauvegarder
uniquement SQL : les bytes des objets immuables doivent être copiés aussi.

Pour une capture : geler les nouvelles écritures, drainer l'outbox collaborative,
prendre un dump transactionnel de la base et l'inventaire des versions avec parents,
puis copier les objets correspondants. Enregistrer taille et SHA-256. Capturer aussi
les règles RLS, migrations, Auth et rôles nécessaires, avec accès strict aux secrets.
Une outbox non drainée rend la capture incomplète : conserver son état séparément.
Ne pas marquer de cohérence si cette procédure n'est pas terminée.

Format de `manifest.json` attendu dans le répertoire de sauvegarde déchiffré :

```json
{
  "schemaVersion": 1,
  "environment": "staging",
  "capturedAt": "2026-09-12T00:00:00Z",
  "database": { "file": "database.sql", "bytes": 123, "sha256": "SHA256_REEL_64_HEXA" },
  "versions": [{
    "scenarioId": "ID_PROJET", "versionId": "ID_VERSION", "parentVersionId": null,
    "file": "objects/ID_VERSION.scenario", "bytes": 123, "sha256": "SHA256_REEL_64_HEXA"
  }]
}
```

Depuis le worktree site, contrôle en lecture seule :

```powershell
node scripts/backup-integrity.mjs 'D:\senario-backup-dechiffre'
```

Il refuse les traversées de chemin, liens sortants, doublons, parents manquants,
cycles, parents inter-projet et bytes altérés. Il vérifie la cohérence interne de
l'inventaire fourni, pas son exhaustivité par rapport à la base ni l'origine du dump.
Le manifeste doit être authentifié par le système de sauvegarde indépendant.

Restauration réelle : provisionner un Supabase LOCAL jetable distinct, bloquer tout
SMTP/paiement/IA, charger dump et objets, puis comparer inventaire SQL restauré au
manifeste, RLS owner/editor/viewer, versions/parents, garde/commentaires, téléchargements
et checksums. Utiliser les commandes de restauration correspondant au format du
dump et à cette cible explicitement validée. Ne jamais restaurer sur la préproduction.
Les commandes SQL exactes dépendent de cette cible encore non fournie ; aucune
restauration réelle ni sauvegarde hors site n'est revendiquée dans ce lot.

## 4. Surveillance et retour arrière

`npm.cmd run phase11:health` fait une sonde réelle finie, sans envoyer d'alerte.
`scripts/alert-policy.mjs` définit une politique pure testée : incident après trois
échecs, ou 5 min de 5xx > 2 % / backlog > 100, une ouverture et un rétablissement
par épisode. Le collecteur futur doit stocker cet état, mesurer à intervalle borné,
détecter sa propre absence et livrer l'alerte à un contact vérifié. Les tests locaux
ne prouvent ni collecte continue ni réception de messages.

Avant déploiement, enregistrer commit, version Worker, URL Vercel, inventaire des
migrations et artefacts, état outbox et résultat des sondes. En cas de régression :
fermer les nouvelles écritures affectées, conserver l'outbox, revenir à la version
applicative compatible identifiée, revalider puis rouvrir. Ne jamais supprimer une
migration ou rétrograder le schéma ; préférer une correction append-only. Une
ancienne UI compatible peut être redéployée dans la preview. Sur incident Stripe,
rejouer seulement le même event_id signé ; aucune attribution manuelle compensatoire.

## 5. Recette finale et publication

Recette : Gratuite (local/aucun Checkout gratuit), Auteur (mensuel/annuel, IA selon
droits), Studio (projets privés/partagés, viewer/editor, commentaires/garde,
reconnexion, conflits et copie locale). Tester les limites via configuration serveur,
jamais via affichage marketing. Retester chaque compte sans droits d'administrateur.

Windows : voir le dossier phase12 de l'application. Validation sur VM vierge,
signature et restauration sont encore attendues. Le certificat Authenticode réduit
les avertissements de provenance ; il n'est pas une obligation universelle pour
exécuter Windows, mais fait partie du critère de distribution retenu pour senario.

Après preuves et revue : connecter senario.app, vérifier HTTPS/CORS/retours Auth et
Stripe, réception e-mails, liens support, installation/mise à jour, sauvegarde et
alerte. Le passage Stripe live et la publication restent des étapes distinctes.
Ne pas enlever noindex ni ouvrir de téléchargement tant que les preuves manquent.
