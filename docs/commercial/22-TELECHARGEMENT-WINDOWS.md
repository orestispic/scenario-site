# Téléchargement Windows

La route publique `/telecharger` présente la bêta Windows, les étapes d’installation et le comportement des mises à jour.

Le bouton utilise l’URL stable :

`https://github.com/orestispic/scenario-app/releases/latest/download/Scenario-Setup.exe`

La publication de l’application doit conserver ce nom d’artefact. Les versions suivantes remplacent automatiquement la cible de l’URL `latest`, sans nécessiter de redéploiement du site.

La page indique explicitement que :

- Windows 10 ou 11 en 64 bits est requis ;
- les mises à jour sont signées et automatiques ;
- un document non enregistré retarde l’installation ;
- l’écriture locale reste disponible sans Internet ;
- SmartScreen peut afficher « Éditeur inconnu » tant que l’exécutable ne possède pas de certificat commercial de signature de code Windows.
