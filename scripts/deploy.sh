#!/usr/bin/env bash
# Run as ordinary developer from a clean Git working checkout.
set -Eeuo pipefail
cd "$(dirname "$0")/.."
if [[ "$(id -u)" -eq 0 ]]; then echo "Run without sudo; script uses sudo only for production" >&2; exit 1; fi
[[ -z "$(git status --porcelain)" ]] || { echo "Dirty checkout; deploy aborted" >&2; exit 1; }
command -v node >/dev/null || { echo "Node.js missing" >&2; exit 1; }
echo "Source revision: $(git rev-parse --short HEAD)"
npm test
service=custom-github-telegram-bridge.service
prod=/opt/custom-github-telegram-bridge
backup="$prod/source-backup-$(date -u +%Y%m%dT%H%M%SZ)-$$"
sudo test -d "$prod/src"
sudo install -d -m 0700 "$backup"
sudo cp -a "$prod/src" "$backup/src"
sudo cp -a "$prod/package.json" "$backup/package.json"
rollback() {
  echo "Release failed; restoring previous code and restarting service." >&2
  sudo rm -rf "$prod/src" || true
  sudo cp -a "$backup/src" "$prod/src" || true
  sudo cp -a "$backup/package.json" "$prod/package.json" || true
  sudo systemctl start "$service" || true
}
trap rollback ERR
sudo systemctl stop "$service"
sudo cp -a src/. "$prod/src/"
sudo cp -a test/. "$prod/test/"
sudo cp package.json "$prod/package.json"
sudo chown -R root:root "$prod/src" "$prod/test" "$prod/package.json"
sudo systemctl start "$service"
sudo systemctl is-active --quiet "$service"
trap - ERR
echo "Service active; deployment complete. Rollback copy retained: $backup"
