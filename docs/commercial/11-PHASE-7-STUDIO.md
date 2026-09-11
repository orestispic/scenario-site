# Phase 7 — collaboration Studio et invitations

## Contrat et frontières

Le contrat public `2026-09-v7` est ajouté sans modifier v1–v6. Les routes `/v6/studios` réutilisent la session authentifiée, la version minimale, les droits effectifs, l’appareil actif et le limiteur distribué des phases 4–6. Le dépôt Studio réévalue ensuite le membership courant et l’existence du scénario non supprimé à chaque appel. Une ressource absente et une ressource non accessible produisent la même réponse afin de limiter l’énumération.

Les rôles sont `owner`, `editor`, `viewer`. Le client peut demander une transition, mais seul le serveur l’autorise. Il refuse notamment l’auto-élévation et le retrait/rabaissement du dernier owner. La révocation du membership met aussi à jour l’accès au scénario ; les appels ultérieurs sont immédiatement refusés.

## Invitations et notifications

Le Worker dérive 256 bits imprévisibles par HMAC d’un secret serveur, de la clé d’idempotence et du Studio. Le jeton est donc lié au Studio et reproductible uniquement côté serveur pour une reprise de livraison ; seul son second HMAC SHA-256 est transmis au dépôt et stocké. Le faux fournisseur local garde temporairement le jeton brut en mémoire afin que le compte synthétique destinataire puisse accepter ou refuser dans l’interface ; il ne l’écrit ni en base, ni dans `localStorage`, ni dans les logs. Le fournisseur de production est injectable mais volontairement sans transport externe en phase 7. Une panne de notification n’annule pas l’invitation déjà committée ; un retry idempotent rejoue la même mutation, retente la livraison avec le même jeton et ne crée pas de double membership. Le fournisseur doit dédupliquer ses envois par `invitationId`.

L’acceptation verrouille l’invitation et vérifie destinataire empreinté, statut, expiration et unicité avant d’écrire la projection de membership, sa révision append-only, l’accès cloud et l’événement. Les refus, révocations, changements de rôle et retraits suivent le même registre d’idempotence lié au profil.

## Journal et protocole de rattrapage

Chaque Studio possède une révision croissante. `studio_events.cursor` est une identité globale monotone ; les événements de membership et de version sont immuables. Après une coupure, le client appelle `GET /v6/studios/:id/events?after=<dernier curseur>` :

1. il traite les événements dans l’ordre du curseur ;
2. il conserve le `nextCursor` seulement après application complète de la page ;
3. tant que `hasMore` vaut vrai, il redemande la page suivante ;
4. si un trou, une révision inattendue ou une indisponibilité survient, il recharge le détail et l’historique de versions depuis le serveur ;
5. il ne fusionne jamais silencieusement deux contenus : chaque sauvegarde garde son parent v6 et un parent obsolète retourne le conflit déterministe existant.

Les interfaces `StudioPresenceProvider`, `StudioEventChannel` et `CollaborativeEditEnvelope` préparent Phase 8. Aucune présence persistée, websocket, CRDT/OT effectif ou remplacement de l’éditeur n’est livré ici.

## État des validations

Fonctionnel localement : routes, autorisations, trois comptes synthétiques, invitation/acceptation/refus/révocation, rôles, retrait, replays et concurrence, journal/catch-up, notification en mémoire, intégration avec versions cloud et interface minimale.

Simulé : identité, stockage Studio, notification et diffusion d’événements sont des adaptateurs locaux déterministes. La migration et les RPC de production sont contrôlées statiquement et compilées avec le Worker, pas exécutées contre PostgreSQL.

Bloqué faute d’infrastructure déjà fournie : application réelle de la migration, validation RLS transactionnelle sous JWT, Durable Object Cloudflare réel et fournisseur de notifications externe. Les clés Supabase/Studio ne sont pas présentes ; aucun compte ni service n’a été créé.

Validation externe à exécuter uniquement sur un Supabase local jetable déjà autorisé :

```powershell
supabase start
supabase db reset
supabase test db supabase/tests/phase7_studio.sql
npx wrangler dev --config wrangler.preproduction.toml --local
npx wrangler deploy --config wrangler.preproduction.toml --dry-run
```

Ne jamais utiliser `supabase db push` pour cette phase. Fournir `STUDIO_INVITATION_PEPPER` uniquement par le gestionnaire de secrets. Le transport de notification devra être configuré et testé sur un bac à sable avant activation.
