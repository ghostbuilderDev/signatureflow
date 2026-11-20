#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
SF_FULL_REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
SF_COMMIT="$(git rev-parse HEAD)"
SF_STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
SF_OWNER="${SF_FULL_REPO%/*}"; SF_NAME="${SF_FULL_REPO#*/}"
SF_PUBLIC_URL="$(gh api "repos/$SF_FULL_REPO/pages" --jq .html_url 2>/dev/null || true)"
if [ -z "$SF_PUBLIC_URL" ]; then SF_PUBLIC_URL="https://${SF_OWNER,,}.github.io/$SF_NAME/"; fi
# Use the actual Pages URL consistently for callbacks, invitations and frontend.
printf %s "$SF_PUBLIC_URL" | gh secret set VITE_APP_URL
wait_for_run() {
 local workflow="$1" found="" attempt
 for attempt in $(seq 1 60); do
  found="$(gh api "repos/$SF_FULL_REPO/actions/workflows/$workflow/runs?event=workflow_dispatch&per_page=20" --jq "[.workflow_runs[] | select(.head_sha == \"$SF_COMMIT\" and .created_at >= \"$SF_STARTED\")][0].id // empty")"
  if [ -n "$found" ]; then printf %s "$found"; return; fi
  sleep 5
 done
 echo "Le déploiement $workflow n’a pas démarré. Consultez https://github.com/$SF_FULL_REPO/actions" >&2
 return 1
}
watch_run() {
 local run="$1"
 if ! gh run watch "$run" --exit-status --interval 5; then
  gh run view "$run" --log-failed || true
  echo "ÉCHEC : mise à jour non publiée. Journal : https://github.com/$SF_FULL_REPO/actions/runs/$run" >&2
  return 1
 fi
}
echo 'Publication du serveur et de la base…'
gh workflow run supabase.yml --ref main
SF_BACKEND_RUN="$(wait_for_run supabase.yml)"
watch_run "$SF_BACKEND_RUN"
echo 'Publication de l’interface…'
SF_PAGES_RUN="$(wait_for_run pages.yml)"
watch_run "$SF_PAGES_RUN"
echo 'Vérification de la version servie…'
SF_VERSION_FILE="$(mktemp)"
trap 'rm -f -- "$SF_VERSION_FILE"' EXIT
for SF_ATTEMPT in $(seq 1 40); do
 if curl -fsSL --max-time 20 "${SF_PUBLIC_URL%/}/version.json?commit=$SF_COMMIT&attempt=$SF_ATTEMPT" -o "$SF_VERSION_FILE"; then
  if SF_EXPECTED_COMMIT="$SF_COMMIT" jq -e --arg commit "$SF_COMMIT" '.version == "2.1.0" and .commit == $commit' "$SF_VERSION_FILE" >/dev/null 2>&1; then
   echo 'SUCCÈS : SignatureFlow 2.1.0 est publiée et vérifiée.'
   echo "Ouvrir : ${SF_PUBLIC_URL%/}/?v=$SF_COMMIT"
   exit 0
  fi
 fi
 sleep 5
done
echo "Le déploiement est terminé, mais la version publique n’est pas encore confirmée : $SF_PUBLIC_URL" >&2
exit 1
