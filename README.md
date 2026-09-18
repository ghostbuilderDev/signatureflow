# SignatureFlow V1.1 — Supabase Journal connecté

PWA de préparation et de signature de documents PDF avec plusieurs signataires. Cette version est préparée pour le projet Supabase actif **journal-chantier-connecte** (`eqfwdcttvnnrakyaacjm`) et reste isolée du Journal existant.

## Fonctionnalités

- connexion administrateur Supabase ;
- import de PDF dans un bucket privé `signatureflow-documents` ;
- plusieurs signataires avec ordre de signature ;
- détection des mentions `signature`, `signataire`, `visa`, `signé` ;
- placement manuel des zones si nécessaire ;
- lien personnel par signataire ;
- signature tactile/souris ;
- insertion de la signature, du nom, de l’e-mail et de l’horodatage dans le PDF ;
- signatures successives sur le PDF courant ;
- hash SHA-256 avant/après signature ;
- journal d’audit ;
- PWA déployable sur GitHub Pages.

## Isolation par rapport au Journal de chantier

Aucune table existante du Journal n’est modifiée. SignatureFlow crée uniquement :

- `signatureflow_documents`
- `signatureflow_signers`
- `signatureflow_signature_fields`
- `signatureflow_audit_events`
- bucket privé `signatureflow-documents`
- Edge Functions `signatureflow-invite-signer`, `signatureflow-get-signing-context`, `signatureflow-submit-signature`

Le projet possède déjà un `RESEND_API_KEY` et un expéditeur `JOURNAL_CR_FROM`. La fonction d’invitation SignatureFlow les réutilise automatiquement.

## Installation Termux

Après téléchargement et extraction :

```bash
termux-setup-storage
cd ~/storage/downloads/signatureflow
chmod +x setup-termux.sh configure-and-deploy.sh
./setup-termux.sh signatureflow public
```

Puis :

```bash
./configure-and-deploy.sh
```

Le second script demande seulement :

- un **Supabase Personal Access Token** ;
- le **mot de passe de la base** du projet `journal-chantier-connecte`.

Il enregistre les secrets GitHub nécessaires, pousse la migration SQL, déploie les 3 Edge Functions et construit la PWA GitHub Pages.

## URL d’authentification

Après le premier déploiement, ajouter l’URL affichée par le script dans :

**Supabase > Authentication > URL Configuration > Redirect URLs**.

Le frontend est déjà configuré avec l’URL du projet et sa clé **publishable**, conçue pour être exposée côté navigateur. Aucune `service_role`/secret key n’est présente dans le dépôt.

## Utilisation

1. Se connecter avec un utilisateur déjà autorisé dans Supabase.
2. Créer un dossier et importer le PDF.
3. Ajouter les signataires.
4. Cliquer sur **Analyser les signatures**.
5. Contrôler ou déplacer/ajouter les zones manuellement.
6. Enregistrer les zones.
7. Envoyer les liens.
8. Chaque destinataire lit le PDF et signe.
9. Télécharger le PDF final depuis le dossier.

## Sécurité

- bucket privé ;
- RLS sur toutes les tables SignatureFlow ;
- documents accessibles aux signataires uniquement via URL temporaire ;
- jeton de signature aléatoire 256 bits stocké seulement sous forme de hash SHA-256 ;
- expiration à 14 jours ;
- ordre de signature imposé ;
- verrou anti-double soumission ;
- empreintes PDF et piste d’audit ;
- aucune clé serveur dans le frontend.

## Portée juridique

La V1 réalise une signature électronique avec consentement, identité déclarée et piste d’audit. Elle ne constitue pas à elle seule une signature électronique qualifiée eIDAS. Pour un besoin contractuel nécessitant une signature avancée ou qualifiée, prévoir un prestataire de confiance adapté.
