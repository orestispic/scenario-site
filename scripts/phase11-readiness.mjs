import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Documentary gate, NOT evidence that external checks have actually run.
 * Every true field requires dated evidence in the release review.
 */
export function publicationBlockers(plan) {
  const blockers = [];
  if (plan.schemaVersion !== 1 || plan.brand !== 'senario') blockers.push('Plan de publication invalide.');
  const checks = {
    domainOwnershipVerified: 'Acheter et vérifier le domaine souhaité, sans présumer sa disponibilité.',
    domainTlsVerified: 'Vérifier DNS et HTTPS du domaine détenu.',
    smtpDeliveryVerified: 'Valider réellement les e-mails : confirmation, récupération et invitations.',
    legalIdentityAndPoliciesApproved: 'Compléter et faire valider identité légale, conditions, confidentialité et conservation.',
    windowsAuthenticodeVerified: 'Signer et vérifier l’installateur Windows avec un certificat valide.',
    updaterSignatureAndRollbackVerified: 'Configurer et tester la mise à jour signée, son interruption et son retour arrière.',
    offsiteBackupRestoreVerified: 'Restaurer une sauvegarde base + objets cohérente dans un environnement jetable.',
    alertDeliveryVerified: 'Vérifier la réception réelle des alertes et la prise en charge support.',
    productionPaymentReviewApproved: 'Valider séparément le passage Stripe production ; conserver le mode test jusque-là.',
    publicationAuthorized: 'Autoriser la publication du livrable final après revue des preuves.',
  };
  for (const [key, message] of Object.entries(checks)) if (plan[key] !== true) blockers.push(message);
  if (typeof plan.contactEmail !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(plan.contactEmail)) blockers.push('Créer une adresse de contact réelle.');
  return blockers;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const plan = JSON.parse(readFileSync(new URL('../release/publication-plan.json', import.meta.url), 'utf8'));
  const blockers = publicationBlockers(plan);
  console.log(blockers.length ? `PUBLICATION BLOQUÉE (${blockers.length} prérequis). Bêta locale autorisée.` : 'Revue documentaire complète : contrôler les preuves avant publication.');
  blockers.forEach((message) => console.log(`- ${message}`));
  process.exitCode = blockers.length ? 2 : 0;
}
