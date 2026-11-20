#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
REPO_NAME="${1:-signatureflow}"
VISIBILITY="${2:-public}"
case "$VISIBILITY" in public|private) ;; *) echo 'Visibilité : public ou private'; exit 1;; esac
if command -v pkg >/dev/null; then pkg install -y git gh unzip; fi
if ! gh auth status >/dev/null 2>&1; then gh auth login --hostname github.com --git-protocol https --scopes workflow --web; fi
gh auth setup-git
if gh repo view "$REPO_NAME" >/dev/null 2>&1; then echo 'Le dépôt existe. Utilisez update-termux.sh pour préserver son historique.'; exit 1; fi
git init -b main
GH_LOGIN="$(gh api user --jq .login)"
git config user.name "$GH_LOGIN";git config user.email "$GH_LOGIN@users.noreply.github.com"
git add .;git commit -m 'SignatureFlow 2.0'
gh repo create "$REPO_NAME" --"$VISIBILITY" --source=. --remote=origin --push
if ! gh api --method POST "repos/$GH_LOGIN/$REPO_NAME/pages" -f build_type=workflow >/dev/null; then echo 'Configurez GitHub Pages > Source : GitHub Actions.'; fi
./configure-and-deploy.sh
