#!/usr/bin/env bash
set -euo pipefail
PACKAGE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_NAME="${1:-ghostbuilderDev/signatureflow}"
TARGET_DIR="${SIGNATUREFLOW_REPO_DIR:-$HOME/signatureflow}"
echo 'SignatureFlow 2.1.0 — signatures nominatives et circuits automatiques'
if command -v pkg >/dev/null 2>&1; then pkg install -y git gh rsync unzip curl jq coreutils; fi
for tool in git gh rsync curl jq; do command -v "$tool" >/dev/null || { echo "Commande manquante : $tool"; exit 1; }; done
if ! gh auth status >/dev/null 2>&1; then gh auth login --hostname github.com --git-protocol https --scopes workflow --web; fi
if [ -z "${GH_TOKEN:-}${GITHUB_TOKEN:-}" ]; then
 SF_AUTH_STATUS="$(gh auth status 2>&1)"
 case "$SF_AUTH_STATUS" in *workflow*) ;; *) gh auth refresh --hostname github.com --scopes workflow ;; esac
 unset SF_AUTH_STATUS
fi
gh auth setup-git
if [ ! -d "$TARGET_DIR/.git" ]; then
 if [ -e "$TARGET_DIR" ]; then echo "Le dossier $TARGET_DIR existe sans dépôt Git. Indiquez un autre SIGNATUREFLOW_REPO_DIR."; exit 1; fi
 gh repo clone "$REPO_NAME" "$TARGET_DIR"
fi
cd "$TARGET_DIR"
SF_ACTUAL_REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
if [ "${SF_ACTUAL_REPO,,}" != ghostbuilderdev/signatureflow ]; then echo "Dépôt inattendu : $SF_ACTUAL_REPO"; exit 1; fi
if [ -n "$(git status --porcelain)" ]; then echo 'Le dépôt contient des modifications locales. Enregistrez-les avant de relancer la mise à jour.'; exit 1; fi
CURRENT_BRANCH="$(git branch --show-current)"
if [ "$CURRENT_BRANCH" != main ]; then echo 'Placez le dépôt sur la branche main avant la mise à jour.'; exit 1; fi
git pull --ff-only origin main
SF_BASE="$(git rev-parse HEAD)"
case "$SF_BASE" in
 1bfe34dc4ad83d4c4d5cc29870ab4894363f329c|591036515ef879315b4011b9c21e08b6912af614|31f304e968cecd176101c5dc764eed6294954ee7) ;;
 *) case "$(git log -1 --format=%s)" in 'SignatureFlow 2.0.1: connexion et publication'*) ;; *) echo 'Une autre mise à jour existe déjà. Arrêt pour préserver cette version.'; exit 1 ;; esac ;;
esac
BACKUP_TAG="signatureflow-before-v2.1-$(date +%Y%m%d-%H%M%S)"
git tag "$BACKUP_TAG"
rsync -a --exclude='.git/' --exclude='node_modules/' --exclude='dist/' --exclude='.env' --exclude='.env.local' --exclude='.env.production' --exclude='test-results/' --exclude='playwright-report/' "$PACKAGE_DIR/" "$TARGET_DIR/"
git add src public scripts tests integration supabase .github package.json package-lock.json vite.config.js index.html .gitignore .env.example README.md VALIDATION.md COMMANDES_TERMUX.txt setup-termux.sh configure-and-deploy.sh update-termux.sh deploy-and-verify.sh termux-secrets-template.sh playwright.config.js deno.json
if ! git diff --cached --quiet; then git -c user.name="$(gh api user --jq .login)" -c user.email="$(gh api user --jq .login)@users.noreply.github.com" commit -m 'SignatureFlow 2.1.0: signatures nominatives et circuits automatiques'; fi
git push origin main
# Restore only missing public settings from the original project configuration.
SF_SECRET_NAMES="$(gh secret list --json name --jq '.[].name')"
has_secret() { case "$SF_SECRET_NAMES" in *"$1"*) return 0;; *) return 1;; esac; }
if ! has_secret VITE_SUPABASE_URL; then printf %s 'https://eqfwdcttvnnrakyaacjm.supabase.co' | gh secret set VITE_SUPABASE_URL; fi
if ! has_secret VITE_SUPABASE_PUBLISHABLE_KEY; then printf %s 'sb_publishable_95GXQ_XVGnvolLedkrIsLA_YJZ0gx4O' | gh secret set VITE_SUPABASE_PUBLISHABLE_KEY; fi
if ! has_secret VITE_APP_URL; then
 SF_OWNER="$(gh repo view --json owner --jq '.owner.login')"
 SF_REPO="$(gh repo view --json name --jq '.name')"
 SF_APP_URL="$(gh api "repos/$SF_OWNER/$SF_REPO/pages" --jq '.html_url' 2>/dev/null || true)"
 if [ -z "$SF_APP_URL" ]; then
  if [ "$SF_REPO" = "$SF_OWNER.github.io" ]; then SF_APP_URL="https://$SF_OWNER.github.io/"; else SF_APP_URL="https://$SF_OWNER.github.io/$SF_REPO/"; fi
 fi
 printf %s "$SF_APP_URL" | gh secret set VITE_APP_URL
fi
if ! has_secret SUPABASE_PROJECT_REF; then printf %s eqfwdcttvnnrakyaacjm | gh secret set SUPABASE_PROJECT_REF; fi
if ! has_secret SUPABASE_ACCESS_TOKEN || ! has_secret SUPABASE_DB_PASSWORD; then
 echo 'Configuration initiale des identifiants Supabase nécessaire.'
 SF_SKIP_DEPLOY=1 bash ./configure-and-deploy.sh
fi
# Backend workflow owns the order: database/functions first, then frontend.
echo "Point de retour local : $BACKUP_TAG"
bash ./deploy-and-verify.sh
