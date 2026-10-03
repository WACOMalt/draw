#!/usr/bin/env bash
# One-time move of Draw from pm2 to a hardened systemd service with an encrypted SMTP credential.
#
#   curl -fsSL https://raw.githubusercontent.com/WACOMalt/draw/main/deploy/setup-systemd.sh -o setup-systemd.sh
#   less setup-systemd.sh          # read it first
#   bash setup-systemd.sh          # as your normal user; it asks for sudo once
#
# Result
#   app:        /opt/draw            (yours; ~/draw/update-server.sh writes here from now on)
#   database:   /var/lib/draw        (owned by the 'draw' system user, mode 700)
#   SMTP:       /etc/draw/smtp.cred  (encrypted with systemd-creds; only the service sees plaintext,
#                                     in its private RAM folder while it runs)
#   service:    draw.service         (user 'draw', no shell, read-only system, no access to /home)
#   sudo rule:  you may restart draw.service and read its status/logs without a password. Nothing else.
# The old ~/draw stays as a backup. Rollback is printed at the end.
set -euo pipefail

ME="$(id -un)"
APP=/opt/draw
DATA=/var/lib/draw
OLD="$HOME/draw"
PUBLIC_URL="${PUBLIC_URL:-https://draw.bsums.xyz}"
ADMIN_EMAILS="${ADMIN_EMAILS:-ben@bsums.xyz}"
RAW="https://raw.githubusercontent.com/${DRAW_REPO:-WACOMalt/draw}/main"

export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null
command -v node >/dev/null || { echo "error: node not found" >&2; exit 1; }
command -v systemd-creds >/dev/null || { echo "error: systemd-creds not found" >&2; exit 1; }

step() { printf '\n== %s\n' "$*"; }

step "sudo (asked once)"
sudo -v

step "System user 'draw' and folders"
id draw >/dev/null 2>&1 || sudo useradd --system --home-dir "$DATA" --no-create-home --shell /usr/sbin/nologin draw
sudo install -d -o "$ME" -g draw -m 755 "$APP"
sudo install -d -o draw -g draw -m 700 "$DATA"
sudo install -d -o root -g root -m 700 /etc/draw

step "SMTP credential (encrypted at rest)"
if sudo test -f /etc/draw/smtp.cred && [ "${REDO_SMTP:-}" != 1 ]; then
  echo "kept the existing /etc/draw/smtp.cred (REDO_SMTP=1 to replace it)"
else
  read -rp "SMTP host [mail.hover.com]: " SMTP_HOST; SMTP_HOST="${SMTP_HOST:-mail.hover.com}"
  read -rp "SMTP port [465]: " SMTP_PORT; SMTP_PORT="${SMTP_PORT:-465}"
  read -rp "SMTP user (a dedicated mailbox is best, e.g. noreply@bsums.xyz): " SMTP_USER
  # Hosted mail rejects a From address other than the login mailbox, so ask only for the name.
  read -rp "Sender name shown in emails [Draw]: " SMTP_FROM; SMTP_FROM="${SMTP_FROM:-Draw}"
  read -rsp "SMTP password (not shown; empty = set up mail later): " SMTP_PASS; echo
  # The password goes through a pipe only: never into a file, an argument list or the history.
  # printf is a shell builtin, so it does not show in the process list either.
  printf '%s' "$SMTP_PASS" | python3 -c '
import json, sys
host, port, user, sender = sys.argv[1:5]
pw = sys.stdin.read()
cfg = {"host": host, "port": int(port), "secure": int(port) == 465, "user": user, "pass": pw, "from": sender} if pw else {}
sys.stdout.write(json.dumps(cfg))
' "$SMTP_HOST" "$SMTP_PORT" "$SMTP_USER" "$SMTP_FROM" | sudo systemd-creds encrypt --name=smtp --with-key=host - /etc/draw/smtp.cred
  unset SMTP_PASS
  sudo chmod 600 /etc/draw/smtp.cred
  echo "saved /etc/draw/smtp.cred"
fi

step "Service unit"
sudo tee /etc/systemd/system/draw.service >/dev/null <<EOF
[Unit]
Description=Draw (${PUBLIC_URL})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=draw
Group=draw
WorkingDirectory=${APP}
ExecStart=${APP}/bin/node ${APP}/dist/server/index.js
Environment=NODE_ENV=production
Environment=HOST=127.0.0.1
Environment=PORT=3210
Environment=DB_PATH=${DATA}/canvas.db
Environment=PUBLIC_URL=${PUBLIC_URL}
Environment=ADMIN_EMAILS=${ADMIN_EMAILS}
LoadCredentialEncrypted=smtp:/etc/draw/smtp.cred
StateDirectory=draw
StateDirectoryMode=0700
Restart=always
RestartSec=2

# Hardening. Node needs writable+executable memory for its JIT, so no MemoryDenyWriteExecute.
NoNewPrivileges=yes
CapabilityBoundingSet=
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictSUIDSGID=yes
RestrictRealtime=yes
RestrictNamespaces=yes
LockPersonality=yes
SystemCallArchitectures=native
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
UMask=0077

[Install]
WantedBy=multi-user.target
EOF

step "Sudo rule: restart and logs of draw.service only"
TMP_SUDOERS="$(mktemp)"
cat > "$TMP_SUDOERS" <<EOF
# Draw: ${ME} may restart the service and read its status and logs. Nothing else.
# --no-pager matters: a pager started as root could open a shell.
${ME} ALL=(root) NOPASSWD: /usr/bin/systemctl restart draw.service, /usr/bin/systemctl --no-pager status draw.service, /usr/bin/journalctl --no-pager -u draw.service -n 200
EOF
sudo visudo -cf "$TMP_SUDOERS" >/dev/null
sudo install -o root -g root -m 440 "$TMP_SUDOERS" /etc/sudoers.d/draw
rm -f "$TMP_SUDOERS"
sudo systemctl daemon-reload

step "Stop the pm2 app and move the database"
PM2_WAS_LIVE=0
if command -v pm2 >/dev/null && pm2 describe draw >/dev/null 2>&1; then
  pm2 delete draw >/dev/null && pm2 save >/dev/null
  PM2_WAS_LIVE=1
  echo "pm2 app 'draw' removed (its files stay in $OLD)"
fi
sudo systemctl stop draw.service 2>/dev/null || true
# Copy pm2's database when it was the live one: on a first run, and also on a re-run after a
# rollback (pm2 has the newest drawings then). The replaced copy is kept as a backup.
if [ -f "$OLD/data/canvas.db" ] && { [ "$PM2_WAS_LIVE" = 1 ] || ! sudo test -f "$DATA/canvas.db"; }; then
  if sudo test -f "$DATA/canvas.db"; then
    BACKUP="$DATA/canvas.db.before-$(date +%Y%m%d-%H%M%S)"
    sudo mv "$DATA/canvas.db" "$BACKUP"
    echo "kept the previous copy as $BACKUP"
  fi
  # A stale journal next to a different database would corrupt it: remove it first.
  sudo rm -f "$DATA/canvas.db-wal" "$DATA/canvas.db-shm"
  for f in "$OLD"/data/canvas.db "$OLD"/data/canvas.db-wal "$OLD"/data/canvas.db-shm; do
    [ -f "$f" ] && sudo install -o draw -g draw -m 600 "$f" "$DATA/"
  done
  echo "copied the database from $OLD/data to $DATA"
fi

step "Install the latest release and start"
curl -fsSL "$RAW/scripts/update-server.sh" -o "$APP/update-server.sh"
bash "$APP/update-server.sh"
sudo systemctl enable draw.service >/dev/null 2>&1

cat <<EOF

== Done
Update later:   bash $APP/update-server.sh
Status:         sudo systemctl --no-pager status draw.service
Logs:           sudo journalctl --no-pager -u draw.service -n 200
Change SMTP:    REDO_SMTP=1 bash setup-systemd.sh   (asks for the SMTP details again)
Rollback:       sudo systemctl disable --now draw.service && pm2 start $OLD/ecosystem.config.cjs && pm2 save
EOF
