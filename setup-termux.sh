#!/data/data/com.termux/files/usr/bin/bash
set -e

REPO_NAME="${1:-signatureflow}"
VISIBILITY="${2:-public}"

echo "== SignatureFlow / installation Termux =="
pkg update -y
pkg install -y git gh unzip

if ! gh auth status >/dev/null 2>&1; then
  echo "Connexion GitHub requise :"
  gh auth login
fi


git init
git branch -M main
GH_LOGIN=$(gh api user --jq .login)
git config user.name "$GH_LOGIN"
git config user.email "$GH_LOGIN@users.noreply.github.com"
git add .
git commit -m "Initial SignatureFlow application" || true

if gh repo view "$REPO_NAME" >/dev/null 2>&1; then
  echo "Le dépôt existe déjà : $REPO_NAME"
else
  gh repo create "$REPO_NAME" --$VISIBILITY --source=. --remote=origin --push
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  OWNER=$(gh api user --jq .login)
  git remote add origin "https://github.com/$OWNER/$REPO_NAME.git"
fi

git push -u origin main

OWNER=$(gh api user --jq .login)
# Active GitHub Pages en mode workflow si le plan GitHub du dépôt l'autorise.
gh api --method POST "repos/$OWNER/$REPO_NAME/pages" -f build_type=workflow >/dev/null 2>&1 || true

echo
echo "Dépôt GitHub créé/poussé."
echo "Étape suivante : renseigner les GitHub Secrets décrits dans README.md puis lancer les workflows Pages et Supabase."
