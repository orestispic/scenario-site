# Plan de développement par phases

| Phase | Objectif | Worktree | Modèle | Tests | Fin précise | Dépendances externes |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | Isoler, auditer et définir fondations | Les deux | Terra | Git, absence de secrets | Documents, SQL et commits locaux présents | Aucune |
| 1 | Contrats clients, cache de droits et UI lecture seule simulée | App + site | Terra | Unitaires TS, build | Aucun droit codé en dur ; cache/compatibilité testés | Aucune |
| 2 | API locale et migrations appliquées sur base de développement isolée | Site | Sol | SQL, API, RLS, intégration | Auth/droits/config fonctionnels sans paiement | Runtime DB de développement |
| 3 | Auth réelle, compte, sessions, récupération mot de passe | Site + app | Sol | E2E auth, sécurité session | Parcours compte complet et révocable | Fournisseur auth/Supabase choisi |
| 4 | Stripe test, prix versionnés, licences et appareils | Site + app | Sol | Webhooks signés, idempotence, limites | Paiement test génère droits figés | Stripe test uniquement |
| 5 | IA serveur et quotas | Site + app | Astra | Quotas, refus, anonymisation, E2E | IA jamais directe ; compteurs fiables | OpenAI serveur, environnement test |
| 6 | Cloud, sync, versions et Studio fondamental | Site + app | Astra | Conflits, restauration, ACL, charge | Version append-only et sync fiables | Stockage/Supabase test |
| 7 | Studio étendu et formats professionnels/partage | App + site | Astra | FDX/Fountain, diff, partage | Fonctions Studio protégées et exportables | Bibliothèques formats à évaluer |
| 8 | Instagram privé avec connexion officielle future | Site + app | Sol | OAuth simulé, planification, audit | Brouillons/calendrier prêts ; aucune publication non autorisée | App Meta, revue Meta ultérieure |
| 9 | Préproduction privée, observabilité et production | Les deux | Astra | E2E multiplateforme, sécurité, rollback | Go/no-go documenté et rollback validé | Hébergement, comptes production |

Chaque phase est indépendante : elle commence par la mise à jour de son contrat et termine par tests, documentation de migration et commit local sur la branche commerciale. Aucun push ni déploiement n’est inclus sans instruction explicite.
