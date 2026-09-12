# Phase 11 — bêta senario, préparation à la publication

## Périmètre et état

Travail exclusivement dans les deux worktrees commerciaux. Le nom public est
désormais **senario** (demande utilisateur). `senario.app` est un domaine
**souhaité, non acheté et dont la disponibilité n'a pas été vérifiée**. Aucune
adresse de contact ni certificat de signature Windows n'est disponible.
Cette phase prépare la bêta ; elle ne certifie pas une ouverture commerciale.
Pas de push, publication du site, paiement réel, e-mail réel ou appel IA payant.
Les étapes externes encore nécessaires sont explicites ci-dessous.

Le nouveau point d'entrée effectivement compilé est `src/beta.tsx`. Le site
historique `src/main.tsx` et l'ancien portail Vinext sont conservés pour référence,
mais ne sont plus le livrable commercial. Les anciens liens GitHub vers les
installateurs source ne sont pas présentés comme des téléchargements senario.
Le logo fourni est réutilisé ; aucune refonte des identifiants ou des fichiers.

## Fonctionnel

- Présentation des projets privés/partagés, commentaires et premières pages,
  navigation mobile, aide, espace compte, connexion/inscription, récupération,
  facturation et redirection Checkout/portail **test**.
- `GET /v11/catalog`, contrat distinct `contracts-v11.ts` : offres visibles
  fournies par le dépôt serveur. Projection des champs publics seulement,
  aucun identifiant Stripe fournisseur, compte, quota ou droit. Ce catalogue
  n'accorde aucune autorisation. CORS, limiteur distribué et request_id conservés.
- Le catalogue regroupe désormais les sélections en trois plans d'affichage
  serveur : **Gratuite**, **Auteur** et **Studio**. Les textes de fonctionnalités
  sont des indications commerciales, jamais une autorisation. Le client démarre
  sur l'annuel, calcule l'équivalent mensuel à partir du montant annuel servi et
  l'économie par rapport à douze mensualités ; il ne contient aucun prix.
  `offers` reste présent pour les consommateurs v11 existants, tandis que `plans`
  porte cette nouvelle présentation sans modifier les contrats v1 à v10.
- Vite expose uniquement trois champs publics explicitement sélectionnés.
  Sans configuration le compte et le catalogue restent fermés, pas de faux serveur
  implicitement activé dans un build public. `.env.phase9.local` est ignoré.
- Access/refresh tokens du **site** en mémoire uniquement. Renouvellement partagé
  entre les requêtes concurrentes, expiration, invalidation et annulation à la
  déconnexion ; une ancienne réponse ne peut rétablir/effacer une nouvelle session.
  L'application native conserve son refresh token dans le coffre système existant.
- Les mutations ne sont pas relancées automatiquement après une réponse incertaine.
  Checkout conserve son contrat v3 et son comportement serveur antérieur : une
  relance manuelle peut créer une autre session test, ce n'est pas une garantie
  nouvelle d'idempotence de Checkout.
- Aucun Analytics tiers dans le bundle bêta ; noindex et no-referrer. Ceci ne
  constitue ni contrôle d'accès au site ni validation juridique.

## E-mails : prêt localement, livraison non configurée

`release/emails/recovery.html` utilise le TokenHash Supabase dans le **fragment**
de l'URL (non transmis au serveur HTTP), jamais un access/refresh token. Le client
efface immédiatement les paramètres sensibles et n'échange le hash qu'après
saisie et confirmation explicite du nouveau mot de passe. Le callback `verify`
précède `PUT /auth/v1/user`, puis la session de récupération est révoquée.
La compatibilité avec les anciens paramètres de requête efface aussi ceux-ci,
mais ne peut retirer une URL déjà reçue par les journaux d'un serveur/proxy.
Ne pas utiliser ces anciennes URLs comme nouveau modèle d'e-mail.

Après acquisition du domaine : créer une véritable boîte support, choisir un
fournisseur SMTP, vérifier SPF/DKIM/DMARC selon ses instructions, configurer
Supabase Authentication > URL Configuration > Site URL avec l'origine HTTPS
détenue, puis Authentication > Email > SMTP et Templates > Reset Password.
Installer le modèle sans activer de tracking des liens. Limiter les URLs de retour
aux origines exactes détenues (aucun wildcard). Vérifier confirmation d'inscription,
lien expiré, lien déjà consommé, mot de passe changé et connexions révoquées avec
des boîtes de test contrôlées. Ne jamais coller un secret SMTP dans Git ou le chat.

Les notifications d'invitation Studio restent celles de l'adaptateur existant :
le transport d'e-mails réel, son outbox opérationnelle et sa livraison ne sont
pas activés dans ce lot. Les invitations dans l'application continuent de fonctionner.
Documentation primaire : [Supabase Email Templates](https://supabase.com/docs/guides/auth/auth-email-templates)
et [récupération de mot de passe](https://supabase.com/docs/guides/auth/passwords).

## Windows / mises à jour

Voir le document phase11 de l'application. L'installateur local `senario Beta`
garde `com.scenario.preproduction`, utilise explicitement le build phase9 et ne
prend pas l'association `.scenario` à l'application source. Le binaire technique
reste `scenario-app.exe` pour éviter de casser les intégrations.
Un installateur non signé a été compilé et inspecté : **non publiable**.

Authenticode et signature de mise à jour Tauri sont deux mécanismes différents.
Le certificat Windows n'existe pas encore ; le plugin de mise à jour, sa clé
durable, son endpoint et l'installation automatique ne sont **pas activés**.
Il faut préparer ces derniers ensemble avec une origine détenue, une clé de
signature sauvegardée hors dépôt, une distribution HTTPS d'artefacts immuables,
une vérification du checksum/signature et un essai de mise à jour interrompue.
Ne pas embarquer une clé privée ou accepter un manifeste sans signature. Ne pas
utiliser une clé temporaire de développement pour les premières installations
publiques. La sauvegarde d'un projet doit précéder tout redémarrage d'update.
Références : [signature Windows Tauri](https://v2.tauri.app/distribute/sign/windows/),
[signature obligatoire de l'updater](https://v2.tauri.app/plugin/updater/).

## Exploitation et critères de sortie

`release/publication-plan.json` garde désormais **10 prérequis bloqués**. `npm run release:check`
sort avec code 2 tant qu'ils ne sont pas tous renseignés. C'est une liste de revue
exécutable, pas une preuve DNS/SMTP/signature : tout passage à true doit renvoyer
à des preuves datées et vérifiées. Aucun déploiement n'est déclenché par ce script.
Le build bêta garde aussi ses liens de téléchargement public désactivés.

`node scripts/phase11-healthcheck.mjs` fait deux lectures bornées sur la seule
préproduction déclarée. Il affiche statut, latence, route normalisée et request_id,
jamais les réponses, identifiants de compte, mots de passe ou contenu.
Il ne programme aucun suivi et n'envoie aucun message. Avant ouverture, brancher
un moniteur indépendant et tester **réellement** sa livraison d'alertes.

Seuils proposés (objectifs, pas SLA mesurés) : indisponibilité après trois sondes
consécutives ; 5xx > 2 % pendant 5 min ; backlog durable > 100 pendant 5 min ;
erreurs de persistance/compaction répétées : alerte immédiate. Corréler request_id
et référence pseudonyme de connexion, jamais contenu ou URL temporaire. Distinguer
403 attendus d'un pic d'abus. Un seul incident ouvert par cause, délai de répétition
15 min, rétablissement explicite, contact d'astreinte à définir.

Reprise : identifier la version Worker et l'état Supabase/R2/DO séparément ;
interrompre les nouvelles écritures en cas de persistance ambiguë sans effacer
l'outbox ; garder les clients en récupération/copie locale ; rejouer les commandes
avec leurs identifiants existants. Pour un webhook, réutiliser l'event_id vérifié,
ne jamais inventer d'attribution. Drainer avant maintenance, révoquer les tickets
lors d'une rotation compromise, déployer une version revue puis rejouer des
fixtures synthétiques avant de réouvrir. Aucun stress destructeur sur la préprod.

Sauvegarde : le dump SQL seul ne sauvegarde **pas les objets des scénarios**.
Prévoir sauvegarde chiffrée hors environnement, inventaire versionId/parent/objectKey/
checksum, copie des objets immuables, marqueur de cohérence et validation des
comptages. Vérifier dans un Supabase local jetable autorisé, avec sessions/clefs
externes neutralisées : droits/RLS, derniers parents, téléchargement et checksums,
commentaires/garde, absence d'accès tiers. N'écraser aucune base distante. Objectifs
à arbitrer : RPO 24 h, RTO 4 h. Une restauration hors site et une réception d'alerte
restent **non exécutées**, Docker n'étant pas disponible sur cet hôte dans cette session.

Identité légale, conditions d'utilisation/vente, conservation, suppression/export
de compte, sous-traitants, support et passage Stripe production nécessitent encore
une décision et une revue. Le texte de confidentialité de bêta n'est pas présenté
comme des mentions légales définitives. `senario.app` n'a pas été acheté/configuré.

## Validation de ce lot

Unités/contrats/migrations, typecheck, lint ciblé, builds, scan sans secret et Worker
à blanc sont locaux, pas des preuves d'infrastructure. Le contrôle SHA-256 gèle
les **17 migrations** jusqu'à phase10 ; aucune migration nouvelle/appliquée ici.
Le scénario 5 000 paragraphes/1 000 opérations couvre trois répliques, ordre inversé,
doublons, tombstones et absence de mutation du document de base. Cela ne constitue
pas un benchmark de pagination graphique ni un test de charge Cloudflare.

E2E Edge **local isolé** du site : catalogue, connexion/déconnexion, mobile 390 px,
aucun stockage de jeton, récupération, changement de mot de passe et Checkout
simulé. Les requêtes externes sont interceptées ; aucun vrai paiement/e-mail.
Un défaut d'invocation du fetch natif a été détecté par ce test et corrigé.
E2E commentaires/premières pages de l'application : trois comptes isolés, garde,
réponses/résolution/réouverture, ancre supprimée, suppression et lecteur.

Validation **réelle distincte** : client de l'application connecté 300 secondes à
Supabase/Cloudflare, trois comptes synthétiques existants, une seule connexion
par compte, zéro erreur, 72/71/71 polls et 29 heartbeats par compte, convergence
finale vérifiée sans journaliser le contenu. Pas d'écriture de scénario par ce soak.
Tests Rust : trois ordinaires puis un test du coffre Windows explicitement lancé,
créant/lisant/supprimant une seule entrée synthétique, tous réussis.

Commandes exécutées (dans le worktree indiqué par leur fichier) :

```powershell
npm.cmd run typecheck
npm.cmd run test:api
node --experimental-transform-types --test tests/phase11-browser.test.ts
node --experimental-transform-types --test worker/tests/phase11-catalog.test.ts
npm.cmd exec oxlint -- src/beta.tsx lib/commercial/browser-account.ts lib/commercial/contracts-v11.ts worker/tests/phase11-catalog.test.ts tests/phase11-browser.test.ts tests/phase11-readiness.test.ts
npm.cmd run test:security
node scripts/security-check.mjs --app
npm.cmd run build -- --mode phase9
node scripts/phase11-readiness.mjs
.\node_modules\.bin\wrangler.cmd deploy --dry-run --config wrangler.preproduction.toml --outdir outputs/phase11-worker
$env:SCENARIO_PLAYWRIGHT_PATH='C:\Users\orepi\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\playwright\index.mjs'
node --experimental-transform-types scripts/phase11-site-e2e.mjs
# Worktree application
npm.cmd test
npm.cmd test -- src/commercial/phase11-large-document.test.ts src/commercial/collaborationConvergence.test.ts
npm.cmd run tauri build -- --config src-tauri/tauri.preproduction.conf.json --bundles nsis
cargo test --manifest-path src-tauri/Cargo.toml --locked
cargo test --manifest-path src-tauri/Cargo.toml --locked native_vault_roundtrip -- --ignored
& scripts/inspect-beta-installer.ps1
& scripts/inspect-beta-installer.ps1 -RequireSigned
node scripts/realtime-soak.mjs 300
node --experimental-transform-types scripts/project-metadata-ui-e2e.mjs
git diff --check
```

Échecs intermédiaires résolus : wrapper Sites build-site incompatible avec le npm
de cet hôte (chemin npm-cli introuvable), remplacé par le build existant ; sandbox
Windows bloquant esbuild/Wrangler, relancés hors sandbox ; ancienne adresse API
publique de site en placeholder corrigée dans le fichier local ignoré ; test du
Checkout simulé sans charset UTF-8 corrigé. Les contrôles RequireSigned et
publication-plan échouent **intentionnellement** et restent bloquants.

La validation hébergée du nouveau catalogue/portail et le commit déployé sont
enregistrés dans l'addendum une fois effectués. Aucun résultat en attente n'est
compté comme une validation réelle réussie.

## Addendum — validations finales du lot

- Commit serveur `9f28191` déployé **uniquement en préproduction** ; version Worker
  `2267d017-20ad-4b42-8267-eca0d72760fe`. Aucun SQL appliqué, aucun secret changé.
- `npm.cmd run phase11:health` réellement exécuté : `/v1/config` et `/v11/catalog`
  répondent 200, staging/test confirmés (736 ms et 461 ms, observations ponctuelles).
- `node --experimental-transform-types scripts/phase11-site-e2e.mjs --hosted` :
  **réussite réelle** Edge + Supabase + Cloudflare, quatre offres, connexion du
  compte Owner synthétique existant, lecture du compte, actualisation, mobile,
  déconnexion. Aucun paiement, inscription, changement de mot de passe ou e-mail
  réel par ce test ; les autres requêtes externes sont refusées par son filtre.
- Suite finale API/contrats/migrations : **143 réussites**. Application : 119.
- Lint étendu réussi sur Worker, observabilité, scripts phase11 et config Vite ;
  lint ciblé du site/runtime/contrats/tests réussi, scans sécurité serveur/client.
- Dernier installateur Windows regénéré après l'optimisation : 3 464 201 octets,
  SHA-256 `b5435f0e6a05785ac1c53365a33bb3b45c537e5996df8dbcf45b0c7c813b56ad`,
  statut `NotSigned` attendu. Toujours non installé et non publié.

L'aperçu local du site est `http://127.0.0.1:4173/` (aucun hébergement public).
Pour le relancer ultérieurement : `npm.cmd run dev:beta` dans ce worktree, ou
`npm.cmd run build:beta` puis `npm.cmd exec vite -- preview --config vite.vercel.config.ts --host 127.0.0.1 --port 4173 --strictPort`.
Le script historique `npm run dev` reste le bac Vinext des phases initiales et
n'est pas la nouvelle entrée commerciale. Le dossier `.openai` est préservé ;
les instructions Sites ont guidé la réutilisation de l'architecture et l'aperçu,
sans enregistrement ni publication sur un nouveau service.

Le test de stabilité réel a précédé le déploiement v11 (il n'a pas été présenté
comme un soak post-déploiement). Les fichiers serveur modifiés pour v11 ne touchent
pas la synchronisation. La connexion au site après déploiement est validée à part.

## Prévisualisation Vercel autorisée

Après achat confirmé de `senario.app`, l'utilisateur a autorisé une prévisualisation
du projet Vercel existant `scenario-site`, sans promotion et sans connexion du
domaine. Le dossier commercial a été relié localement au projet ; les trois seules
variables Vercel Preview enregistrées sont les valeurs publiques API/Supabase.
`.vercelignore` exclut environnements, Worker, Supabase, scripts, tests, documents
et livrables opérationnels de l'archive envoyée.

Prévisualisation Vercel privée créée et déclarée `READY` :
`https://scenario-site-hxzddrq8c-orepicard-4993s-projects.vercel.app`.
Elle est ajoutée comme origine **exacte** à la préproduction Cloudflare ; aucun
wildcard Vercel n'est autorisé. Cette URL peut être retirée lors du remplacement
de la prévisualisation. Le domaine acheté reste non connecté et la production
Vercel existante n'est pas remplacée. La validation réelle et la version Worker
postérieure sont consignées après leur exécution.

Le domaine `senario.app` a été acheté sur le même compte Vercel, vérifié par la
page du registrar (expiration 12 septembre 2027, renouvellement automatique actif,
nameservers Vercel). `domainOwnershipVerified` passe donc à true. Le domaine ne
sert encore aucun projet : DNS/TLS applicatif reste bloqué jusqu'à la promotion.

Le Worker préproduction a ensuite été redéployé, version
`f3347e14-0c87-4d43-ad4c-c81d27d35531`, uniquement pour ajouter cette origine
exacte. Lecture réelle CORS : 200, contrat v11, `Access-Control-Allow-Origin`
strictement égal à l'URL de preview. La preview exige l'authentification Vercel ;
une lecture CLI authentifiée a confirmé le titre `senario`, `noindex, nofollow`
et le bundle attendu. La capture Edge du parcours compte/offres mobile est créée
localement dans les outputs ignorés. Aucun checkout ou e-mail réel.
