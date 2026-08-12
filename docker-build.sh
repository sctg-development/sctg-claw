#!/usr/bin/env bash
# Builds the sctg/claw image from the pinned openclaw/ submodule source.
#
# The build context MUST be ./openclaw (not this repo's root): the upstream
# stages in ./Dockerfile (copied from openclaw/Dockerfile) do `COPY . .` and
# expect the OpenClaw monorepo tree (extensions/, packages/, scripts/, ...) at
# the context root. Running `docker build .` from this repo's root uses the
# wrong context and fails with e.g. `"/extensions": not found`.
#
# Usage:
#   ./docker-build.sh                       # local single-arch build, tag :local
#   ./docker-build.sh -t sctg/claw:latest   # custom tag
#   ./docker-build.sh --push                # multi-arch buildx build + push (needs `docker buildx create --use` once, and registry login)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

if [ ! -f openclaw/package.json ]; then
  echo "ERROR: openclaw/ submodule looks empty. Run: git submodule update --init --recursive" >&2
  exit 1
fi

TAG="sctg/claw:local"
PUSH=0
EXTRA_ARGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    -t|--tag)
      TAG="$2"
      shift 2
      ;;
    --push)
      PUSH=1
      shift
      ;;
    *)
      EXTRA_ARGS+=("$1")
      shift
      ;;
  esac
done

# macOS ships bash 3.2, where "${EXTRA_ARGS[@]}" on an empty array errors
# under `set -u`. Guard with a length check instead of relying on bash 4.4+
# empty-array expansion semantics.
if [ "$PUSH" = "1" ]; then
  echo "==> Multi-arch build + push: $TAG (linux/amd64,linux/arm64)"
  if [ ${#EXTRA_ARGS[@]} -gt 0 ]; then
    docker buildx build --platform linux/amd64,linux/arm64 -f Dockerfile -t "$TAG" --push "${EXTRA_ARGS[@]}" ./openclaw
  else
    docker buildx build --platform linux/amd64,linux/arm64 -f Dockerfile -t "$TAG" --push ./openclaw
  fi
else
  echo "==> Local single-arch build: $TAG"
  if [ ${#EXTRA_ARGS[@]} -gt 0 ]; then
    docker build -f Dockerfile -t "$TAG" "${EXTRA_ARGS[@]}" ./openclaw
  else
    docker build -f Dockerfile -t "$TAG" ./openclaw
  fi
fi
