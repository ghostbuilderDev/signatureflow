#!/data/data/com.termux/files/usr/bin/bash
set -e
# REMPLACER LES VALEURS AVANT EXECUTION. Ne jamais committer ce fichier après modification.

export VITE_SUPABASE_URL='https://PROJECT_REF.supabase.co'
export VITE_SUPABASE_PUBLISHABLE_KEY='sb_publishable_xxx'
export VITE_APP_URL='https://GITHUB_USER.github.io/REPOSITORY/'
export SUPABASE_PROJECT_REF='PROJECT_REF'
export SUPABASE_ACCESS_TOKEN='sbp_xxx'
export SUPABASE_DB_PASSWORD='DATABASE_PASSWORD'
export RESEND_API_KEY='re_xxx'
export EMAIL_FROM='SignatureFlow <signature@votre-domaine.fr>'

printf %s "$VITE_SUPABASE_URL" | gh secret set VITE_SUPABASE_URL
printf %s "$VITE_SUPABASE_PUBLISHABLE_KEY" | gh secret set VITE_SUPABASE_PUBLISHABLE_KEY
printf %s "$VITE_APP_URL" | gh secret set VITE_APP_URL
printf %s "$SUPABASE_PROJECT_REF" | gh secret set SUPABASE_PROJECT_REF
printf %s "$SUPABASE_ACCESS_TOKEN" | gh secret set SUPABASE_ACCESS_TOKEN
printf %s "$SUPABASE_DB_PASSWORD" | gh secret set SUPABASE_DB_PASSWORD
printf %s "$RESEND_API_KEY" | gh secret set RESEND_API_KEY
printf %s "$EMAIL_FROM" | gh secret set EMAIL_FROM

echo "Secrets GitHub enregistrés."
