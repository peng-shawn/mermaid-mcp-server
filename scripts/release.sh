#!/bin/bash
# Bumps the version, tags it, and pushes; the tag triggers the npm publish
# workflow. The server reads its version from package.json, so package.json
# and package-lock.json are the only files that change.
#
#   scripts/release.sh <version|patch|minor|major|prerelease>
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: scripts/release.sh <version|patch|minor|major|prerelease>" >&2
  exit 1
fi

if [ "$(git rev-parse --abbrev-ref HEAD)" != "main" ]; then
  read -p "Not on main. Continue? (y/n) " -n 1 -r
  echo
  [[ $REPLY =~ ^[Yy]$ ]] || exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree is not clean; commit or stash first." >&2
  exit 1
fi

git pull --ff-only origin main
npm run build
node --test --test-concurrency=1 test/engine.test.mjs test/server.test.mjs

# Updates package.json and package-lock.json, commits, and tags v<version>
VERSION=$(npm version "$1" -m "chore: release version %s")
git push origin main
git push origin "$VERSION"
echo "Pushed $VERSION; the publish workflow will stage it on npm for 2FA approval."
