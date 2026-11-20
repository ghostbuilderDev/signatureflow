#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
PROJECT_REF="eqfwdcttvnnrakyaacjm"
SUPABASE_PUBLIC_URL="https://eqfwdcttvnnrakyaacjm.supabase.co"
SUPABASE_PUBLIC_KEY="sb_publishable_95GXQ_XVGnvolLedkrIsLA_YJZ0gx4O"
if ! gh auth status >/dev/null 2>&1; then gh auth login --hostname github.com --git-protocol https --scopes workflow --web; fi
OWNER="$(gh repo view --json owner --jq '.owner.login')"; REPO="$(gh repo view --json name --jq '.name')"
if [ "$REPO" = "$OWNER.github.io" ]; then APP_URL="https://$OWNER.github.io/"; else APP_URL="https://$OWNER.github.io/$REPO/"; fi
echo "Cible Supabase : $PROJECT_REF — tables signatureflow uniquement"
read -r -p "URL publique SignatureFlow [$APP_URL] : " CUSTOM_APP_URL
APP_URL="${CUSTOM_APP_URL:-$APP_URL}"
read -r -s -p 'Supabase Personal Access Token : ' SF_ACCESS_TOKEN; echo
read -r -s -p 'Mot de passe de la base : ' SF_DB_PASSWORD; echo
[ -n "$SF_ACCESS_TOKEN" ] && [ -n "$SF_DB_PASSWORD" ] || { echo 'Les deux valeurs sont nécessaires.'; exit 1; }
printf %s "$APP_URL" | gh secret set VITE_APP_URL
printf %s "$SUPABASE_PUBLIC_URL" | gh secret set VITE_SUPABASE_URL
printf %s "$SUPABASE_PUBLIC_KEY" | gh secret set VITE_SUPABASE_PUBLISHABLE_KEY
printf %s "$PROJECT_REF" | gh secret set SUPABASE_PROJECT_REF
printf %s "$SF_ACCESS_TOKEN" | gh secret set SUPABASE_ACCESS_TOKEN
printf %s "$SF_DB_PASSWORD" | gh secret set SUPABASE_DB_PASSWORD
unset SF_ACCESS_TOKEN SF_DB_PASSWORD
if [ "${SF_SKIP_DEPLOY:-0}" != 1 ]; then bash ./deploy-and-verify.sh; fi
echo 'Les liens copiables fonctionnent sans service e-mail. L’envoi direct réutilise RESEND_API_KEY et JOURNAL_CR_FROM, ou SIGNATUREFLOW_EMAIL_FROM.'
