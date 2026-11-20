# SignatureFlow 2.1.0 — vérifications du 20 novembre 2026

Évolution : blocs de signature nominatifs avec fonction, carnet de contacts, circuits « validation complète » et « prise de connaissance », lecture de toutes les pages, copies automatiques du PDF et arbitrage OCR des sommaires. 13 tests Node, 5 tests Deno et compilation de production réussis pour cette révision. La nouvelle révision n’est pas encore publiée sur le dépôt distant : l’installeur Termux réalise cette étape avec l’authentification du propriétaire. La délivrabilité réelle de Resend et une connexion avec les identifiants réels ne sont pas testées ici.

Livraison réalisée à partir de `signatureflow-main.zip` (V1.1.1), sans modification d’un service distant et sans envoi réel à un destinataire.

## Résultats locaux

| Vérification | Résultat |
|---|---|
| `npm test` | 13 tests réussis |
| `npm run test:functions` | 5 tests réussis |
| Vérification de types Deno des 3 Edge Functions | Réussie |
| `npm run build` | Compilation de production réussie |
| Syntaxe Bash des scripts Termux | Réussie |
| Audit npm de l’ensemble des dépendances | 0 vulnérabilité signalée lors de la préparation |
| Signature sur PDF avec CropBox décalé et rotations 0°, 90°, 180°, 270° | Coordonnées testées et rendu PDF inspecté visuellement |

Les tests Node couvrent : analyse de libellés et d’ancres, rejet du mot « signature » dans un sommaire, conservation d’un véritable bloc nom/prénom/fonction/signature, recomposition de fragments, séparation de colonnes, champs natifs, déduplication, cadres raster, tableaux, rapprochement nominatif, OCR réel sur une image scannée française, extraction de coordonnées sur un PDF réel, insertion des blocs nominatifs et validation des champs.

Le test PostgreSQL utilise PGlite, une exécution locale de PostgreSQL, avec des schémas Auth et Storage simulés. Il applique les trois migrations, teste l’isolation RLS des documents et contacts, la validation finale obligatoire avant émission, le remplacement transactionnel des zones, l’interdiction de modifier les jetons depuis le navigateur, l’ordre séquentiel, le verrou entre signataires, le refus d’un PDF périmé, la répétition d’une requête déjà réussie et l’annulation.

Les cinq tests de fonctions exécutent les vrais gestionnaires Deno avec des réponses Supabase/Resend simulées. Ils testent le contexte public nominatif, les liens personnels et l’échec d’envoi, une signature réelle avec lecture enregistrée et empreintes avant/après, l’envoi automatique du PDF final en pièce jointe et les rejets de jetons/consentements invalides. Ils ne valident pas la configuration du projet Supabase distant ou la délivrabilité de son e-mail.

## Vérifications restant sur l’installation cible

- Quatre scénarios Playwright sont fournis : préparation sur bureau, OCR d’un scan sur mobile et deux scénarios d’authentification. Leur lancement ici a été bloqué par l’interdiction système de créer le socket Chromium. **Ces scénarios ne sont pas comptés parmi les 18 tests réussis.**
- Exécuter ces scénarios sur une machine autorisant Chromium, ou via le workflow GitHub `Tests`.
- Vérifier après installation : connexion organisateur, disponibilité des migrations, lecture d’un lien personnel sur un autre téléphone, signature par deux destinataires, téléchargement final, éventuel envoi Resend.
- Essayer les formulaires réellement utilisés dans vos chantiers. Aucun document métier n’a été fourni pour mesurer le taux de détection ou la précision sur votre collection.
- La passerelle JDC est fournie et documentée ; le code du Journal n’étant pas joint, son interface n’a pas été modifiée.

Le ZIP 2.1.0 contient les sources, les migrations, les scripts Termux et les procédures. `npm ci` prépare les ressources OCR et les polices ; GitHub Actions compile l’interface. Le déploiement réel est déclenché par les scripts, après authentification GitHub et configuration des secrets nécessaires.
