# Renouvellement de licence hors ligne

GET /v3/entitlements?offline=1 accepte les en-têtes appareil existants. La recherche
serveur utilise l'empreinte pepperée et le propriétaire authentifié ; seul un
appareil actif reçoit deviceId et deviceFingerprint dans la signature ES256.
serverTime est également signé. Les anciens clients restent compatibles.

offlineLeaseUntil applique la politique mensuelle (période payée + 3 jours,
maximum 34 jours) et annuelle (30 jours, bornés à la période payée). Seuls les
abonnements actifs dont le dernier paiement est payé bénéficient de cette
extension. Les autres snapshots conservent la limite serveur existante.

Pas de modification SQL. Déployer le Worker puis reconnecter/activer l'appareil
dans le nouveau client. Un Worker ancien ne permet pas d'émettre la nouvelle
preuve hors ligne ; le client reste utilisable localement et en ligne.
Les tests locaux couvrent les durées, l'émission liée à l'appareil et le refus de
renouvellement après révocation. La validation hébergée reste à exécuter.
