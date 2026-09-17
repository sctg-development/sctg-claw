#!/usr/bin/env bash
# Restores the production OpenClaw pod from a pair of backup archives
# produced by the nightly backup cron:
#
#   openclaw backup create --output ~/Backups/openclaw --verify
#   tar czf ~/Backups/openclaw/<ts>-home-backup.tar.gz \
#     .bash_history .bashrc .config .local .ssh .viminfo gcloud
#
# `openclaw backup restore` only extracts a verified archive into a FRESH,
# empty staging directory -- it deliberately refuses to write into a live
# state dir ("non-empty directories are refused"). It is a safety primitive,
# not a full in-place restore. This script does the remaining manual steps:
#   1. verify the openclaw-backup archive
#   2. restore it into a staging dir inside the pod
#   3. move the live /home/node/.openclaw aside (kept, never deleted)
#   4. copy the staged archive into place
#   5. extract the home-backup tar's dotfiles (.bashrc, .ssh, gcloud, ...)
#   6. restart the gateway pod so it picks up the restored state
#
# Usage:
#   ./scripts/restore-openclaw-backup.sh <openclaw-backup.tar.gz> <home-backup.tar.gz>
#
# Both paths may be local files (uploaded into the pod automatically) or
# paths already present inside the pod (e.g. /tmp/foo.tar.gz), for the case
# where the backups were downloaded straight into the pod for inspection
# first.
#
# Env overrides: NAMESPACE (default: claw), LABEL_SELECTOR (default:
# app.kubernetes.io/instance=sctg-claw), CONTAINER (default: gateway).

set -euo pipefail

NAMESPACE="${NAMESPACE:-claw}"
LABEL_SELECTOR="${LABEL_SELECTOR:-app.kubernetes.io/instance=sctg-claw}"
CONTAINER="${CONTAINER:-gateway}"

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <openclaw-backup.tar.gz> <home-backup.tar.gz>" >&2
  exit 1
fi

OPENCLAW_BACKUP="$1"
HOME_BACKUP="$2"

POD="$(kubectl get pod -n "$NAMESPACE" -l "$LABEL_SELECTOR" -o jsonpath='{.items[0].metadata.name}')"
if [ -z "$POD" ]; then
  echo "ERROR: no pod found for -n $NAMESPACE -l $LABEL_SELECTOR" >&2
  exit 1
fi
echo "Target pod: $POD (namespace $NAMESPACE, container $CONTAINER)"

kexec() { kubectl exec -n "$NAMESPACE" "$POD" -c "$CONTAINER" -- "$@"; }
kexec_sh() { kubectl exec -n "$NAMESPACE" "$POD" -c "$CONTAINER" -- sh -c "$1"; }

# Uploads a local file into the pod's /tmp, or passes through a path that
# already exists inside the pod. Prints the resulting in-pod path on stdout
# (progress goes to stderr so it doesn't pollute the captured value).
copy_into_pod() {
  local local_path="$1" remote_name="$2"
  if [ -f "$local_path" ]; then
    echo "Copying $local_path -> pod:/tmp/$remote_name" >&2
    kubectl cp -n "$NAMESPACE" "$local_path" "$POD:/tmp/$remote_name" -c "$CONTAINER"
    printf '%s' "/tmp/$remote_name"
  elif kexec_sh "test -f '$local_path'"; then
    printf '%s' "$local_path"
  else
    echo "ERROR: '$local_path' not found locally or inside pod $POD" >&2
    exit 1
  fi
}

REMOTE_OPENCLAW_BACKUP="$(copy_into_pod "$OPENCLAW_BACKUP" "$(basename "$OPENCLAW_BACKUP")")"
REMOTE_HOME_BACKUP="$(copy_into_pod "$HOME_BACKUP" "$(basename "$HOME_BACKUP")")"

echo
echo "== Verifying openclaw backup archive =="
kexec openclaw backup verify "$REMOTE_OPENCLAW_BACKUP"

TS="$(date +%s)"
STAGE="/tmp/restore-staging-$TS"

echo
echo "== Restoring archive to a fresh staging dir =="
kexec openclaw backup restore "$REMOTE_OPENCLAW_BACKUP" --target "$STAGE" --json

STAGED_OPENCLAW="$(kexec_sh "find '$STAGE' -maxdepth 5 -type d -path '*/payload/posix/home/node/.openclaw'")"
if [ -z "$STAGED_OPENCLAW" ]; then
  echo "ERROR: could not locate staged .openclaw payload under $STAGE" >&2
  exit 1
fi

echo
echo "This will replace the live state at /home/node/.openclaw on pod $POD"
echo "and the dotfiles listed in the home-backup tar. The current live"
echo ".openclaw is kept, renamed aside inside the pod -- nothing is deleted."
read -r -p "Continue? [y/N] " CONFIRM
if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
  echo "Aborted. Staged extraction left at $STAGE for inspection."
  exit 1
fi

SAFETY_DIR="/home/node/.openclaw.pre-restore-$TS"
echo
echo "== Swapping in the restored .openclaw (live moved aside to $SAFETY_DIR) =="
kexec_sh "
set -e
mv /home/node/.openclaw '$SAFETY_DIR'
cp -a '$STAGED_OPENCLAW' /home/node/.openclaw
chown -R node:node /home/node/.openclaw
install -d -m 0700 -o node -g node /home/node/.openclaw/plugin-skills /home/node/.openclaw/tmp
"

echo
echo "== Applying home-backup dotfiles (.bash_history .bashrc .config .local .ssh .viminfo gcloud) =="
kexec_sh "cd /home/node && tar xzf '$REMOTE_HOME_BACKUP' && chown -R node:node .bash_history .bashrc .config .local .ssh .viminfo gcloud 2>/dev/null || true"

echo
echo "== Restarting the gateway pod to pick up restored state =="
kubectl delete pod -n "$NAMESPACE" "$POD"

echo "Waiting for a replacement pod to become ready..."
NEW_POD=""
for _ in $(seq 1 60); do
  CANDIDATE="$(kubectl get pod -n "$NAMESPACE" -l "$LABEL_SELECTOR" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
  if [ -n "$CANDIDATE" ] && [ "$CANDIDATE" != "$POD" ]; then
    READY="$(kubectl get pod -n "$NAMESPACE" "$CANDIDATE" -o jsonpath="{.status.containerStatuses[?(@.name==\"$CONTAINER\")].ready}" 2>/dev/null || true)"
    if [ "$READY" = "true" ]; then
      NEW_POD="$CANDIDATE"
      break
    fi
  fi
  sleep 5
done

if [ -z "$NEW_POD" ]; then
  echo "ERROR: timed out waiting for a ready replacement pod. Check: kubectl get pods -n $NAMESPACE" >&2
  exit 1
fi
echo "Pod $NEW_POD ready."

echo
echo "== Post-restore doctor check =="
kubectl exec -n "$NAMESPACE" "$NEW_POD" -c "$CONTAINER" -- openclaw doctor | sed -n '/State integrity/,/Backups/p'

echo
echo "Done. Previous live state preserved at $SAFETY_DIR inside $NEW_POD's PVC"
echo "(same volume, survives the restart) -- remove manually once verified."
