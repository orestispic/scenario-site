# IA : configuration des modèles et budgets

## État vérifié le 13/09/2026

- Migration `20260925000000_ai_token_budgets.sql` appliquée à `zblnsdyaoljnezxdidtx`.
- Configuration active : `62b960dc-f107-406d-b1bb-e4f94cf572fc`.
- Worker `scenario-commercial-api-preproduction` déployé :
  `61655ed6-e472-4d08-bda0-a3ca3e0a2e1b`.
- Test hébergé `node scripts/verify-ai-tokens.mjs` réussi : budgets du compte
  synthétique Owner, rejet anonyme 401, refus du RPC direct avec JWT utilisateur.
  Aucun appel fournisseur ni dépense de tokens lors de ce test.
- Clé `OPENAI_API_KEY` présente uniquement dans les secrets Cloudflare du Worker.
  Sa valeur n'est ni dans le dépôt, ni dans l'application, ni dans les journaux.
- Test fournisseur réel `npm run ai:provider:verify` réussi avec le compte
  synthétique Owner : génération `gpt-5-nano`, comptage serveur et débit réel de
  115 tokens confirmés. Après ce test : 0,19 % du budget journalier et 0,01 % du
  budget mensuel synthétiques utilisés.
- Application locale : 134 tests réussis et compilation réussie. Pas de nouvel
  installateur Windows ni de publication du site dans cette intervention.
- Backend : 11 nouveaux tests réussis ; suite complète 161/162. Le test ancien
  `commercial production entry never builds legacy download or analytics entry`
  échoue car il interdit le lien `releases/latest` déjà présent dans le site
  avant cette intervention. Ce fichier du site n'a pas été modifié ici.

La configuration à modifier est **`config/ai-policy.json`**. Aucun modèle ni quota
ne vient de l’application. Les anciennes variables `OPENAI_SHORT_ACTION_MODEL`
et `OPENAI_PDF_IMPORT_MODEL` ne pilotent plus le Worker hébergé.

## Valeurs de départ

| Offre | Tokens/jour | Tokens/mois | Plafond de coût estimé/jour | /mois |
|---|---:|---:|---:|---:|
| Gratuite (`discovery`) | 0 | 0 | 0 € | 0 € |
| Auteur (`author_ai`) | 20 000 | 600 000 | 0,01 € | 0,30 € |
| Studio | 60 000 | 1 800 000 | 0,03 € | 0,90 € |

Le mois est calendaire UTC (pas un mois glissant ni la période Stripe), le jour
commence à minuit UTC. Le plafond mensuel retenu provisoirement est 30 fois le
journalier : le 31e jour peut donc être limité si tout a été consommé.

GPT-5 nano : 0,05 USD/million en entrée, 0,40 USD/million en sortie, tarifs standard
vérifiés le 13/09/2026 : https://developers.openai.com/api/docs/models/gpt-5-nano.
Ces tarifs doivent être revérifiés lors d'un changement de modèle ou de prix.
`eurPerUsdCeiling: 1.25` est une hypothèse volontairement prudente, **pas un cours
de change constaté**, ni une garantie de facture TTC. Elle est modifiable pour
intégrer votre marge de change/frais/taxes. Le plafond protège le coût calculé
selon cette grille. Il faut aussi suivre les dépenses du compte fournisseur.

Les plafonds en tokens sont prudents : 20 000 tokens au tarif de sortie majoré
coûtent au maximum 0,01 €. Les tokens d'entrée coûtent moins ; consommer 100 %
des tokens ne signifie donc pas forcément dépenser un centime. Un second
compteur de coût, indépendant, protège aussi les changements de modèle en cours
de mois. Aucun reliquat ne se reporte. Traduction, réécriture et PDF partagent
les mêmes budgets par compte, tous appareils confondus.

## Changer une offre ou un modèle

1. Modifier `dailyTokens`, `monthlyTokens`, `dailyEur`, `monthlyEur` de l’offre.
2. Pour un autre modèle : changer `model`, **ses deux tarifs**, les limites
   d'entrée/sortie et éventuellement `reasoningEffort` dans `models` pour chaque
   opération. Retirer `reasoningEffort` si le modèle ne le supporte pas.
3. Valider sans rien envoyer :
   `node scripts/configure-ai-tokens.mjs`
4. Appliquer à la préproduction avec le fichier serveur local protégé existant :
   `node scripts/configure-ai-tokens.mjs --apply --env-file .env.phase9.local --project-ref zblnsdyaoljnezxdidtx`

Ce script ne contient pas de secret, ne lance aucun appel IA et ne publie pas le
site. Il affiche le domaine ciblé et la version de configuration, jamais les
identifiants. Les nouveaux réglages prennent effet sur les nouveaux appels,
**sans reconstruire l’application et sans réinitialiser la consommation**.
Un appel déjà admis garde son modèle, ses tarifs et sa réservation. Une course
entre changement de configuration et admission est refusée (`ai_policy_changed`).
`enabled: false` coupe les nouvelles générations sans perdre l'historique.
Ne jamais placer les secrets dans ce JSON, Git, une variable VITE_* ou le client.

## Installation initiale / déploiement

1. Vérifier que le projet lié est `zblnsdyaoljnezxdidtx`.
2. `npx supabase db push --dry-run --linked` : seule
   `20260925000000_ai_token_budgets.sql` doit être nouvelle.
3. Appliquer la migration, puis le fichier de configuration.
4. Déployer le Worker avec `npx wrangler deploy --config wrangler.preproduction.toml`.
5. Ajouter **uniquement dans les secrets du Worker** une clé OpenAI de projet
   restreinte à Responses et au comptage :
   `npx wrangler secret put OPENAI_API_KEY --config wrangler.preproduction.toml`.
   Le terminal demande la valeur ; ne pas la passer en argument ni dans le chat.
6. Tester une génération synthétique courte, son usage réel et les refus 401/429.
   La disponibilité du modèle pour le compte OpenAI doit être vérifiée en vrai.

La migration désactive l'ancien RPC de réservation par requête. Pendant un
déploiement partiel, l'IA échoue fermée ; elle ne repasse jamais aux anciens quotas.
Ne pas réactiver cet ancien RPC pour un rollback : couper l'IA et corriger le
Worker. Le reste de l'application n'utilise pas ces nouvelles tables.

## Architecture et garanties vérifiables

- JWT vérifié, compte résolu côté serveur, droit IA, appareil actif et version
  compatible vérifiés. Le client ne peut fournir ni modèle, ni tarifs, ni quota,
  ni identifiant de compte pour débiter quelqu'un d'autre.
- Précomptage officiel `/v1/responses/input_tokens` sur le même texte, instructions
  et schéma. Réservation atomique de l'entrée (+256 tokens de marge) + sortie
  maximale, dans une transaction PostgreSQL verrouillée par utilisateur.
- `max_output_tokens` est imposé côté serveur (raisonnement inclus), entrée
  limitée, corps de requête et de réponse bornés. Aucune troncature automatique.
- `usage.input_tokens + usage.output_tokens` remplace la réservation avant
  validation de la réponse. Tokens en cache comptés dans l'entrée, raisonnement
  déjà inclus dans la sortie : pas de double comptage. Le tarif d'entrée non
  cachée est retenu par prudence pour le garde-fou de coût.
- Idempotence liée au compte, à l'opération et à l'empreinte HMAC du contenu.
  Un même identifiant ne peut générer deux fois. Aucun texte de scénario n'est
  enregistré dans le registre de quotas ; pas de corps de prompt dans les logs.
- Échec explicite avant génération : réservation libérée. Timeout, coupure,
  usage manquant/incohérent ou échec de comptabilisation : réservation conservée.
  Une erreur de parsing après usage connu reste facturée en tokens.
- Tables/RPC inaccessibles à `anon`/`authenticated`. Seul le serveur peut écrire
  les usages. Le taux de requêtes anti-flood subsiste séparément de la facturation
  en tokens ; ce n'est pas une allocation de requêtes par abonnement.
- Le modèle ne reçoit **aucun secret** : clé dans l'en-tête HTTP seulement,
  jamais dans les messages. Pas de fichiers, outils, MCP, navigation, fonctions
  serveur, conversation distante ni exécution de code. URL fournisseur fixe,
  redirections refusées. Instructions utilisateur dans le rôle utilisateur,
  jamais interpolées dans les instructions système. Sortie traitée comme texte
  non fiable. Une injection peut dégrader la réponse, pas acquérir des capacités
  absentes ni modifier les quotas. Ce n'est pas une promesse qu'un modèle ne
  produira jamais un texte indésirable.
- L'application affiche les pourcentages calculés par SQL dans Compte et licence
  et Réglages IA. Rafraîchissement après chaque appel, au retour au premier plan
  et toutes les 15 s tant que le panneau est visible ; ce n'est pas un flux push.
  Une donnée indisponible n'est jamais présentée comme 0 %.

## Réconcilier un appel incertain

Ne jamais libérer une réservation simplement parce qu'elle est ancienne ou sur
la déclaration d'un client. Vérifier les journaux d'usage du fournisseur à l'aide
du `request_id` (métadonnée `scenario_request_id`) et du `provider_response_id`
quand disponible. Si l'usage exact est prouvé, un opérateur de confiance peut
appeler `ai_token_command` avec `settle` et les compteurs fournisseur. L'opération
est idempotente et conserve les tarifs d'origine. Sans preuve, conserver la
réservation. Si un appel dépasse sa réservation, son usage réel est conservé et
`budget_anomaly` bloque le compte jusqu'à audit opérateur. Aucun endpoint public
ne permet de rembourser, modifier un tarif ou lever ce blocage.

## Vérification locale

`node --experimental-transform-types --test worker/tests/ai-token-budgets.test.ts`
exécute la migration inchangée dans PostgreSQL embarqué (PGlite), avec dépendances
minimales synthétiques. Il couvre doubles appels, saturation parallèle, périodes,
RLS/privilèges, changement de configuration, erreurs, coût, injection de champs,
comptage et fournisseur simulé. Il ne remplace pas un test du fournisseur réel ni
un test de charge multi-Worker sur la préproduction.
