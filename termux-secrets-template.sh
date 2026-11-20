#!/usr/bin/env bash
set -euo pipefail
# Compatibilité avec le nom du script de la V1 : saisie masquée, aucune valeur à écrire dans ce fichier.
exec bash "$(dirname -- "${BASH_SOURCE[0]}")/configure-and-deploy.sh"
