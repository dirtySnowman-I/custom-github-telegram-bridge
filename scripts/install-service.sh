#!/usr/bin/env bash
# One-time installation. Review and run explicitly with sudo.
set -Eeuo pipefail
if [[ "$(id -u)" -ne 0 ]]; then echo "Run with: sudo bash scripts/install-service.sh" >&2; exit 1; fi
project="$(cd "$(dirname "$0")/.." && pwd)"
cd "$project"
[[ -f .env ]] || { echo "Create local .env from .env.example first" >&2; exit 1; }
node_path="$(command -v node || true)"
[[ -n "$node_path" ]] || { echo "Install system-wide Node.js >=22.16 first" >&2; exit 1; }
"$node_path" -e 'const [major,minor] = process.versions.node.split(".").map(Number);if(major < 22 || (major===22 && minor<16))process.exit(1)' ||
  { echo "Node.js 22.16+ required in sudo PATH" >&2; exit 1; }
npm test
service=custom-github-telegram-bridge.service
prod=/opt/custom-github-telegram-bridge
state=/var/lib/custom-github-telegram-bridge
config=/etc/custom-github-telegram-bridge
if ! id -u telegram-github-bridge >/dev/null 2>&1; then
  useradd --system --user-group --home-dir "$state" --shell /usr/sbin/nologin telegram-github-bridge
fi
install -d -m 0755 "$prod" "$prod/bin" "$prod/src" "$prod/test"
install -d -m 0700 "$config"
install -d -o telegram-github-bridge -g telegram-github-bridge -m 0700 "$state"
install -m 0755 "$(readlink -f "$node_path")" "$prod/bin/node"
cp -a "$project/src/." "$prod/src/"
cp -a "$project/test/." "$prod/test/"
install -m 0644 "$project/package.json" "$prod/package.json"
chown -R root:root "$prod"
# root-only file, consumed by systemd PID 1; do not print its contents.
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
grep -v '^DATA_DIR=' "$project/.env" > "$tmp" || true
printf 'DATA_DIR=%s\n' "$state" >> "$tmp"
install -o root -g root -m 0600 "$tmp" "$config/env"
install -o root -g root -m 0644 "$project/systemd/$service" "/etc/systemd/system/$service"
systemctl daemon-reload
systemctl enable --now "$service"
systemctl is-active --quiet "$service"
echo "Service installed and active: $service"
echo "Secrets: $config/env (root only). Persistent data: $state"
