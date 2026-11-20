# SignatureFlow 2.0.1 — préparation et signature de PDF

## Correctif connexion et publication (20 novembre 2026)

La V2 avait été poussée sur GitHub mais le workflow `Deploy Supabase` 44666256130 s’était arrêté sur `npm test` : le test OCR échouait avant les migrations et la publication de l’interface. GitHub Pages servait donc toujours la V1.1.1. Le test utilise désormais les polices Liberation livrées avec PDF.js au lieu d’une police système variable ; ses assertions de détection sont conservées.

Connexion principale par e-mail et mot de passe du compte JDC existant. Bouton pour afficher le mot de passe, récupération/définition du mot de passe et lien magique facultatif. Aucun compte n’est créé automatiquement. Modifier ce mot de passe modifie aussi le compte JDC. Les signataires conservent leur accès personnel sans connexion.

Le workflow ajoute les deux URL de retour de SignatureFlow à la liste des redirections Auth en conservant les entrées et l’URL principale de JDC. Le token Supabase doit autoriser la lecture et l’écriture de la configuration Auth. Une erreur de droits est affichée par la commande ; aucun secret ne doit être envoyé dans cette conversation.

`update-termux.sh` pousse le correctif puis `deploy-and-verify.sh` attend les deux workflows, retourne une erreur si l’un échoue, et contrôle `version.json` ainsi que le commit réellement servi. Le cache PWA est renouvelé automatiquement. Le ZIP contient les sources ; les dépendances et ressources OCR sont installées et compilées par GitHub Actions.

Installation : télécharger `SIGNATUREFLOW-V2.0.1-TERMUX.zip`, puis exécuter les commandes de `COMMANDES_TERMUX.txt`. L’installeur direct transmis avec le ZIP permet aussi l’installation sans téléchargement manuel. Ne pas réutiliser l’ancien installeur V2.0.

Mise à jour du projet fourni (V1.1.1). Interface française pour préparer des PDF, attribuer des emplacements à plusieurs personnes et recueillir leurs signatures par liens personnels, sans compte destinataire.

## Ce qui est livré

- Tableau de bord et préparation adaptés au téléphone et au bureau.
- PDF jusqu’à 20 Mo et 200 pages ; 40 signataires et 500 zones par dossier.
- Détection des champs natifs PDF, des libellés français/anglais et de quelques libellés européens, des lignes/cadres et des cellules de tableaux de signatures.
- OCR français/anglais sur les pages scannées, avec moteur et modèles hébergés avec l’application. L’analyse ne transmet pas le PDF à un service d’IA externe.
- Ancres explicites : `{{signature}}`, `{{signature_alice}}`, `{{initials}}`, `{{name}}`, `{{date}}`, `{{text}}`, `{{checkbox}}`. Le suffixe peut aider à reconnaître un nom ou un rôle.
- Indice de confiance heuristique, propositions à vérifier, rapprochement avec les noms et rôles. Aucune attribution à tour de rôle. Un indice n’est pas une mesure statistique de précision.
- Placement manuel, déplacement, redimensionnement, choix du type et du signataire, suppression et confirmation de chaque proposition.
- Signature, paraphe, nom, date serveur, texte et case à cocher. Une signature ou un paraphe est nécessaire pour chaque destinataire.
- Liens personnels de 256 bits, conservés sous forme d’empreinte en base, valables 14 jours. Les liens sont copiables et partageables ; l’envoi direct par e-mail est facultatif.
- Signatures en parallèle ou selon l’ordre des signataires. Un verrou au niveau du document évite les écrasements concurrents ; un changement de PDF impose sa relecture.
- PDF privé, URL de lecture temporaire de 15 minutes, consentement serveur, SHA-256 et historique exportable en JSON.
- Les signatures déjà enregistrées restent présentes lors des signatures suivantes. Les coordonnées suivent le CropBox et les rotations 0/90/180/270°.
- Annulation des liens d’un dossier en cours. Les liens renouvelés remplacent les anciens pour les personnes qui n’ont pas signé.
- Passerelle optionnelle Journal de Chantier dans `integration/journal-de-chantier.js`.

## Mise à jour avec Termux

Télécharger `SIGNATUREFLOW-V2.0.1-TERMUX.zip` dans **Téléchargements**, puis :

```bash
termux-setup-storage
pkg install -y unzip
SF_STAGE="$(mktemp -d "$HOME/signatureflow-v2.XXXXXX")"
unzip -q "$HOME/storage/downloads/SIGNATUREFLOW-V2.0.1-TERMUX.zip" -d "$SF_STAGE"
bash "$SF_STAGE/signatureflow-main/update-termux.sh"
```

Par défaut, le script utilise le dépôt GitHub **signatureflow** et le dossier `~/signatureflow` ; s’il n’existe pas localement, il le clone. Le dépôt GitHub doit déjà exister. Un autre dépôt peut être indiqué en argument ; un dossier local différent avec `SIGNATUREFLOW_REPO_DIR` :

```bash
SIGNATUREFLOW_REPO_DIR="$HOME/mon-dossier" bash "$SF_STAGE/signatureflow-main/update-termux.sh" Proprietaire/Depot
```

Le script exige une branche `main` sans modifications locales, avance avec `git pull --ff-only`, crée un tag local de retour puis ajoute les fichiers de la V2. Il ne supprime pas le dépôt et n’utilise pas de push forcé. Les fichiers `.env` existants restent préservés. Il lance le workflow Supabase ; l’interface se déploie seulement après le succès de la base et des fonctions.

Le tag permet de retrouver le code précédent ; **il n’annule pas les migrations de base de données**. La migration V2 est additive. Elle nettoie uniquement les associations incohérentes de zones vers un signataire d’un autre document avant d’ajouter la contrainte qui les interdit.

### Première configuration ou secrets manquants

Dans le dépôt local :

```bash
cd ~/signatureflow
bash configure-and-deploy.sh
```

Le script renseigne aussi les deux secrets publics Vite qui manquaient à la configuration initiale. Il demande les secrets Supabase dans des saisies masquées et les transmet à GitHub Secrets. Aucune clé `service_role` n’est incluse dans le navigateur ou l’archive.

Secrets GitHub nécessaires :

| Secret | Valeur |
|---|---|
| `VITE_SUPABASE_URL` | URL du projet Supabase |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Clé publique publishable |
| `VITE_APP_URL` | URL publique exacte de SignatureFlow |
| `SUPABASE_PROJECT_REF` | Référence du projet |
| `SUPABASE_ACCESS_TOKEN` | Jeton personnel autorisant le déploiement |
| `SUPABASE_DB_PASSWORD` | Mot de passe de la base |

Le projet déjà référencé par les sources est **journal-chantier-connecte**, `eqfwdcttvnnrakyaacjm`. Les scripts ne créent ou ne modifient que les tables/fonctions/politiques préfixées SignatureFlow et son bucket privé ; les tables métier du Journal ne sont pas modifiées. Les clés publiques existantes doivent toujours être valides. Si elles ont changé, mettez à jour `.env.example` et `configure-and-deploy.sh` ou les secrets GitHub.

Dans Supabase Authentication, autoriser l’URL publique de SignatureFlow dans **Redirect URLs**. Le compte organisateur doit déjà exister ; la connexion ne crée pas de compte inconnu. GitHub Pages doit avoir pour source **GitHub Actions**. S’il n’est pas déjà activé, le configurer dans les paramètres du dépôt.

Les workflows utilisent une version 2 du CLI Supabase fixée dans `package-lock.json`. Le workflow `supabase.yml` applique les deux migrations et déploie les trois fonctions, puis déclenche `pages.yml`. Pour la base partagée avec JDC, le workflow récupère d’abord l’historique distant en lecture seule dans un dossier isolé, puis y ajoute uniquement les deux migrations SignatureFlow qui ne sont pas déjà enregistrées. Il applique ces migrations avec `--include-all`, sans modifier ni réparer les numéros d’historique du Journal. Si des tables SignatureFlow ont été créées manuellement sous un autre historique, une collision peut arrêter le déploiement : il faut alors vérifier cet état avant de reprendre, sans effacer l’historique.

Pour une toute première installation sans dépôt existant : extraire le ZIP, puis lancer `bash setup-termux.sh signatureflow public` depuis `signatureflow-main`. Le script crée le dépôt et lance la configuration.

## Configuration e-mail

Le partage de liens n’exige aucun service d’e-mail. Les boutons **Copier**, **Partager** et **E-mail** permettent de transmettre le lien depuis JDC ou la messagerie de l’appareil.

Pour l’envoi automatique depuis le serveur, il faut dans les secrets **Edge Functions Supabase** :

- `RESEND_API_KEY` ;
- `SIGNATUREFLOW_EMAIL_FROM`, ou l’expéditeur existant `JOURNAL_CR_FROM`, ou `EMAIL_FROM`.

L’expéditeur doit être autorisé chez Resend. Le projet initial annonçait ces paramètres existants ; leur disponibilité n’a pas été vérifiée dans le projet distant. Chaque échec d’envoi est indiqué séparément et le lien reste disponible à copier. Le workflow configure `SIGNATUREFLOW_APP_URL` pour éviter d’utiliser par erreur l’URL de JDC à la place de celle de SignatureFlow.

Les destinataires ne sont jamais contactés par l’installation : l’organisateur déclenche explicitement les invitations dans l’application.

## Parcours utilisateur

1. Se connecter comme organisateur et importer le PDF.
2. Ajouter les personnes et, si utile, le rôle mentionné sur le document.
3. Analyser le PDF. Les pages sans texte exploitable passent en OCR ; « OCR sur toutes les pages » peut aider les PDF mixtes.
4. Vérifier la position, la taille, le type et le destinataire de **chaque** zone ; cocher sa confirmation. Ajouter les emplacements manquants manuellement.
5. Enregistrer les zones, puis créer ou envoyer les liens. Le dossier est alors figé.
6. Le destinataire ouvre son lien, lit le document, complète les champs, trace sa signature et ses initiales si demandées, puis confirme son consentement.
7. Télécharger la version signée. Actualiser le dossier organisateur pour suivre les réponses et exporter les preuves JSON.

Si deux personnes consultent simultanément le PDF et qu’une autre signature modifie le document, la seconde est invitée à actualiser et à relire la version mise à jour. Une requête répétée après une signature déjà enregistrée ne signe pas deux fois. Un traitement interrompu libère son verrou ; un verrou abandonné expire après trois minutes.

Les modifications des zones et destinataires sont interdites après la création des liens, y compris par l’API du navigateur. Pour corriger un dossier envoyé, l’annuler et créer un nouveau dossier depuis l’original.

## Intégration Journal de Chantier

Le ZIP fourni ne contient pas le code de JDC ; cette livraison ne prétend donc pas avoir ajouté un bouton dans son interface. Deux usages sont possibles :

- **Immédiat** : copier un lien individuel SignatureFlow, puis le coller dans un message JDC ou un e-mail.
- **Intégration dans le code de JDC** : importer `integration/journal-de-chantier.js`, créer le brouillon avec le client Supabase connecté du Journal puis ouvrir l’éditeur. Les zones se préparent et se vérifient dans SignatureFlow avant tout envoi.

```js
import {prepareSignatureFlow, getSignatureFlowProgress} from './integration/journal-de-chantier.js'

const {documentId, editorUrl} = await prepareSignatureFlow({
  supabase, // client connecté existant du Journal, jamais service_role
  file: pdfFile, // File ou Blob PDF
  title: 'Briefing Montereau — S49',
  sourceRef: chantier.id,
  signers: [
    {name: 'Alice Dupont', email: 'alice@example.fr', role: 'Responsable travaux'},
    {name: 'Bob Martin', email: 'bob@example.fr', role: 'Intervenant'}
  ],
  appUrl: SIGNATUREFLOW_URL // URL publique exacte de votre installation
})
// Naviguer dans le même onglet évite le blocage des popups après une requête asynchrone.
location.assign(editorUrl)
// Dans un écran JDC de suivi :
const progress = await getSignatureFlowProgress(supabase, documentId)
```

Le dossier reste la propriété de l’utilisateur Supabase connecté. Si JDC et SignatureFlow utilisent des origines différentes, l’organisateur peut devoir se reconnecter dans SignatureFlow. Aucun jeton de connexion n’est transmis dans l’URL.

## Développement et tests

Node.js 22.12+ recommandé.

```bash
npm ci
cp .env.example .env
# Renseigner l’URL publique de votre installation, ou laisser VITE_APP_URL vide en local.
npm run dev -- --host 127.0.0.1
npm test
npm run test:functions
npm run build
# Sur une machine autorisant Chromium :
npx playwright install chromium
npm run test:e2e
```

`npm ci` prépare les ressources OCR et les polices. `npm run build` génère le dossier `dist/` à servir par HTTPS. Les liens de signature et l’enregistrement exigent le backend configuré et déployé ; ouvrir simplement `index.html` par `file://` ne suffit pas.

La version compilée de l’archive utilise la clé publique déjà fournie avec le projet et déduit son URL depuis la page courante. Les workflows reconstruisent avec les secrets GitHub.

**Vérifications réalisées dans l’environnement de préparation** : voir `VALIDATION.md`. Les tests de navigateur sont fournis mais leur exécution ici est bloquée par l’environnement. Aucun envoi réel d’e-mail, aucune signature d’un document utilisateur et aucun déploiement distant n’ont été effectués.

## Limites à connaître

L’analyse combine des heuristiques géométriques et de l’OCR. Elle n’a pas été mesurée sur votre collection de formulaires SNCF et ne peut garantir le repérage de toutes les zones : scans flous, écriture manuscrite, tableaux complexes, texte vertical, scans tournés à l’intérieur de la page ou libellés inhabituels demandent une vérification et parfois un placement manuel. Pour une mise en page répétitive, les champs PDF natifs ou les ancres explicites sont plus fiables. Le moteur ne convertit pas les formulaires XFA et ne déchiffre pas les PDF protégés.

Le consentement et l’identité déclarée sont associés au lien personnel ; il n’y a ni contrôle de pièce d’identité, ni OTP SMS, ni certificat de signature PAdES, ni horodatage qualifié. Il s’agit d’un outil de signature simple avec piste d’audit, pas d’une certification équivalente aux offres avancées de DocuSign. Une signature numérique préexistante est refusée lors de la création d’un nouveau dossier, car réécrire ce PDF pourrait l’invalider.

La police des mentions ajoutées est Helvetica : les accents latins usuels sont conservés, les caractères hors de son répertoire sont remplacés par `?` dans le PDF ; la saisie intégrale reste dans la piste d’audit. Les signatures sont des images, conservées dans le PDF. Les documents ne sont pas mis en cache par le service worker ; consultation et signature partagées nécessitent une connexion.
