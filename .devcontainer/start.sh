#!/usr/bin/env bash
# Starts Openline inside a GitHub Codespace (or any dev container).
set -euo pipefail
cd "$(dirname "$0")/.."

# In a Codespace the app is reached at https://<codespace>-3000.<domain>, not localhost, so links in
# emails (verification, invites, unsubscribe) must point there.
if [[ -n "${CODESPACE_NAME:-}" && -n "${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-}" ]]; then
  export WEB_URL="https://${CODESPACE_NAME}-3000.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}"
fi

echo "Starting Openline at ${WEB_URL:-http://localhost:3000} (leave this terminal open)."
echo "Emails are printed here: look for lines starting [mail:verify_email]."
exec pnpm dev
