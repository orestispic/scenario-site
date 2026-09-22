/** Public information pages. */
export function InformationPages({ page }: { page?: string }) {
  return (
    <>
      {(!page || page === 'support') && (
        <section className="section help" id="support">
          <h2>Aide et support</h2>
          <p>
            Pour toute question sur Senario, écrivez à{' '}
            <a href="mailto:support@senario.app">support@senario.app</a>.
          </p>
          <details>
            <summary>Signaler un problème</summary>
            <p>
              Indiquez la version de senario, votre système, l’heure du problème
              et les étapes pour le reproduire. S’il apparaît, ajoutez
              l’identifiant de la demande. N’envoyez ni mot de passe, ni clé, ni
              scénario confidentiel. Masquez les informations personnelles sur
              les captures.
            </p>
          </details>
          <details>
            <summary>Mettre votre travail en sécurité</summary>
            <p>
              Enregistrez une copie de votre projet au format .scenario depuis
              le menu Fichier. Ce format conserve le projet modifiable ; un PDF
              sert à la lecture et ne remplace pas cette sauvegarde. En cas de
              conflit cloud, conservez une copie locale avant de choisir une
              version.
            </p>
          </details>
          <details>
            <summary>Gérer votre compte ou demander vos données</summary>
            <p>
              Adressez votre demande à{' '}
              <a href="mailto:support@senario.app">support@senario.app</a>. La
              suppression du compte n’est pas encore disponible en
              libre-service. Exportez vos projets et organisez le transfert des
              projets partagés avant de demander leur suppression.
            </p>
          </details>
        </section>
      )}
      {(!page || page === 'confidentialite') && (
        <section className="section help" id="confidentialite">
          <h2>Vos données</h2>
          <p>
            Découvrez comment vos projets et votre compte sont utilisés dans
            Senario.
          </p>
          <details open>
            <summary>Projets locaux et projets cloud</summary>
            <p>
              Les projets locaux restent sur votre appareil, sauf lorsque vous
              choisissez une opération cloud ou une fonction IA. Un projet cloud
              peut rester privé ou être partagé avec les membres que vous
              invitez. Les premières pages et commentaires font partie du projet
              partagé.
            </p>
          </details>
          <details>
            <summary>Compte, services et journaux</summary>
            <p>
              Supabase traite l’authentification et le stockage cloud ;
              Cloudflare exécute l’API et la collaboration ; Vercel héberge le
              site ; Stripe gère les paiements. Les journaux
              applicatifs sont conçus pour exclure les textes des scénarios,
              prompts, réponses IA et secrets. Les fournisseurs peuvent
              conserver leurs propres journaux techniques.
            </p>
          </details>
          <details>
            <summary>Sessions et droits sur vos données</summary>
            <p>
              Les jetons de connexion du site restent en mémoire jusqu’à la
              fermeture de la session. La prévisualisation privée utilise
              également l’authentification Vercel. Pour toute demande d’accès,
              de rectification, d’export ou de suppression, écrivez à{' '}
              <a href="mailto:support@senario.app">support@senario.app</a>. Vous
              pouvez adresser une réclamation à la CNIL.
            </p>
          </details>
          <p>
            Pour toute question concernant vos données ou votre compte, écrivez
            à <a href="mailto:support@senario.app">support@senario.app</a>.
          </p>
        </section>
      )}
      {(!page || page === 'conditions') && (
        <section className="section help" id="conditions">
          <h2>Conditions d’utilisation</h2>
          <p>
            Senario permet d’écrire, de préparer et de partager des scénarios.
            Les prix et modalités applicables sont présentés avant la
            confirmation de votre commande.
          </p>
          <p>
            Vous conservez vos droits sur vos textes. Ne partagez que des
            contenus que vous êtes autorisé à utiliser, invitez uniquement les
            personnes concernées et conservez une sauvegarde personnelle. Les
            fonctions IA peuvent produire des erreurs : relisez leurs résultats.
          </p>
          <p>
            Les abonnements et leurs paiements sont gérés de manière sécurisée
            par Stripe. Vous pouvez retrouver les informations de votre formule
            depuis votre compte.
          </p>
        </section>
      )}
      {(!page || page === 'mentions') && (
        <section className="section help" id="mentions">
          <h2>Mentions légales</h2>
          <p>
            Projet porté par Orestis Picard (Orestis Production), SIRET
            95295149900013. Domaine : senario.app.
          </p>
          <p>
            Le site est hébergé chez Vercel. Contact :{' '}
            <a href="mailto:support@senario.app">support@senario.app</a>.
          </p>
        </section>
      )}
    </>
  );
}
