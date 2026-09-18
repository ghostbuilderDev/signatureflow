#!/data/data/com.termux/files/usr/bin/bash
set -e

PROJECT_REF="eqfwdcttvnnrakyaacjm"

echo "== SignatureFlow / déploiement sur journal-chantier-connecte =="

if ! gh auth status >/dev/null 2>&1; then
  echo "Connexion GitHub requise."
  gh auth login
fi

OWNER=$(gh repo view --json owner --jq '.owner.login')
REPO=$(gh repo view --json name --jq '.name')
if [ "$REPO" = "$OWNER.github.io" ]; then
  APP_URL="https://$OWNER.github.io/"
else
  APP_URL="https://$OWNER.github.io/$REPO/"
fi

echo "URL de l'application : $APP_URL"
echo
read -r -s -p "Supabase Personal Access Token : " SUPABASE_ACCESS_TOKEN; echo
read -r -s -p "Mot de passe de la base du projet journal-chantier-connecte : " SUPABASE_DB_PASSWORD; echo

printf %s "$APP_URL" | gh secret set VITE_APP_URL
printf %s "$PROJECT_REF" | gh secret set SUPABASE_PROJECT_REF
printf %s "$SUPABASE_ACCESS_TOKEN" | gh secret set SUPABASE_ACCESS_TOKEN
printf %s "$SUPABASE_DB_PASSWORD" | gh secret set SUPABASE_DB_PASSWORD

echo
echo "Secrets enregistrés. Lancement des déploiements..."
gh workflow run supabase.yml
gh workflow run pages.yml

echo
echo "Déploiements lancés. Suivi : gh run list"
echo "URL prévue : $APP_URL"
echo
echo "Dans Supabase > Authentication > URL Configuration, ajouter :"
echo "$APP_URL"
echo "Le service e-mail Resend existant du Journal de chantier est réutilisé automatiquement."
