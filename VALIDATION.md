# SignatureFlow 2.0 — vérifications du 20 novembre 2026

Livraison réalisée à partir de `signatureflow-main.zip` (V1.1.1), sans modification d’un service distant et sans envoi réel à un destinataire.

## Résultats locaux

| Vérification | Résultat |
|---|---|
| `npm test` | 12 tests réussis |
| `npm run test:functions` | 4 tests réussis |
| Vérification de types Deno des 3 Edge Functions | Réussie |
| `npm run build` | Compilation de production réussie |
| Syntaxe Bash des scripts Termux | Réussie |
| Audit npm de l’ensemble des dépendances | 0 vulnérabilité signalée lors de la préparation |
| Signature sur PDF avec CropBox décalé et rotations 0°, 90°, 180°, 270° | Coordonnées testées et rendu PDF inspecté visuellement |

Les tests Node couvrent : analyse de libellés et d’ancres, recomposition de fragments, séparation de colonnes, champs natifs, déduplication, cadres raster, tableaux, rapprochement nominatif, OCR réel sur une image scannée française, extraction de coordonnées sur un PDF réel, insertion de signatures et validation des champs.

Le test PostgreSQL utilise PGlite, une exécution locale de PostgreSQL, avec des schémas Auth et Storage simulés. Il applique les deux migrations, teste les politiques RLS entre propriétaires, le remplacement transactionnel des zones, la conservation des anciennes zones en cas d’échec, l’interdiction de modifier les jetons depuis le navigateur, l’ordre séquentiel, le verrou entre signataires, le refus d’un PDF périmé, la répétition d’une requête déjà réussie et l’annulation.

Les quatre tests de fonctions exécutent les vrais gestionnaires Deno avec des réponses Supabase/Resend simulées. Ils testent le contexte public, les liens personnels et l’échec d’envoi, une signature réelle de PDF avec empreintes avant/après et les rejets de jetons/consentements invalides. Ils ne valident pas la configuration du projet Supabase distant ou la délivrabilité de son e-mail.

## Vérifications restant sur l’installation cible

- Deux scénarios Playwright sont fournis : préparation sur bureau et OCR d’un scan sur mobile. Leur lancement ici a été bloqué par les restrictions de l’environnement Chromium ; le navigateur distant n’accède pas au serveur local. **Ces scénarios ne sont pas comptés parmi les 16 tests réussis.**
- Exécuter ces scénarios sur une machine autorisant Chromium, ou via le workflow GitHub `Tests`.
- Vérifier après installation : connexion organisateur, disponibilité des migrations, lecture d’un lien personnel sur un autre téléphone, signature par deux destinataires, téléchargement final, éventuel envoi Resend.
- Essayer les formulaires réellement utilisés dans vos chantiers. Aucun document métier n’a été fourni pour mesurer le taux de détection ou la précision sur votre collection.
- La passerelle JDC est fournie et documentée ; le code du Journal n’étant pas joint, son interface n’a pas été modifiée.

Le ZIP contient les sources, les migrations, les ressources OCR, un dossier compilé `dist/`, les scripts Termux et les procédures. Le déploiement réel est déclenché par les scripts, après authentification GitHub et configuration des secrets nécessaires.
