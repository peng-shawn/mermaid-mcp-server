#!/bin/bash

# Script to help with the release process

# Check if a version argument was provided
if [ -z "$1" ]; then
  echo "Error: No version specified"
  echo "Usage: ./scripts/release.sh <version|patch|minor|major>"
  echo "Examples:"
  echo "  ./scripts/release.sh 0.1.4    # Set specific version"
  echo "  ./scripts/release.sh patch    # Increment patch version (0.1.3 -> 0.1.4)"
  echo "  ./scripts/release.sh minor    # Increment minor version (0.1.3 -> 0.2.0)"
  echo "  ./scripts/release.sh major    # Increment major version (0.1.3 -> 1.0.0)"
  exit 1
fi

VERSION_ARG=$1

# Check if the version is a semantic increment or specific version
if [[ "$VERSION_ARG" =~ ^(patch|minor|major)$ ]]; then
  # It's a semantic increment
  INCREMENT_TYPE=$VERSION_ARG
  # Get the current version to display in logs
  CURRENT_VERSION=$(grep -o '"version": "[^"]*"' package.json | cut -d'"' -f4)
  echo "Using semantic increment: $INCREMENT_TYPE (current version: $CURRENT_VERSION)"
else
  # It's a specific version - validate semver format
  if ! [[ $VERSION_ARG =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z-]+)?(\+[0-9A-Za-z-]+)?$ ]]; then
    echo "Error: Version must follow semantic versioning (e.g., 1.2.3, 1.2.3-beta, etc.)"
    echo "Or use one of: patch, minor, major"
    exit 1
  fi
  # Store the specific version
  SPECIFIC_VERSION=$VERSION_ARG
  echo "Using specific version: $SPECIFIC_VERSION"
fi

# Check if we're on the main branch
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "main" ]; then
  echo "Warning: You are not on the main branch. Current branch: $CURRENT_BRANCH"
  read -p "Do you want to continue? (y/n) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
  fi
fi

# Check if working directory is clean
if [ -n "$(git status --porcelain)" ]; then
  echo "Error: Working directory is not clean. Please commit or stash your changes."
  exit 1
fi

# Pull latest changes
echo "Pulling latest changes from origin..."
git pull origin main

# Check current versions in files
PACKAGE_VERSION=$(grep -o '"version": "[^"]*"' package.json | cut -d'"' -f4)
PACKAGE_LOCK_VERSION=$(grep -o '"version": "[^"]*"' package-lock.json | head -1 | cut -d'"' -f4)
INDEX_VERSION=$(grep -o 'version: "[^"]*"' index.ts | cut -d'"' -f2)

echo "Current versions:"
echo "- package.json: $PACKAGE_VERSION"
echo "- package-lock.json: $PACKAGE_LOCK_VERSION"
echo "- index.ts: $INDEX_VERSION"

# Function to update index.ts version
update_index_version() {
  local old_version=$1
  local new_version=$2
  local commit_msg=$3
  
  echo "Updating version in index.ts from $old_version to $new_version..."
  sed -i '' "s/version: \"$old_version\"/version: \"$new_version\"/" index.ts
  git add index.ts
  
  if [ -n "$commit_msg" ]; then
    git commit -m "$commit_msg"
  fi
}

if [ "$PACKAGE_VERSION" != "$PACKAGE_LOCK_VERSION" ] || [ "$PACKAGE_VERSION" != "$INDEX_VERSION" ]; then
  echo "Warning: Version mismatch detected between files."
  
  if [ -n "$SPECIFIC_VERSION" ]; then
    echo "Will update all files to version: $SPECIFIC_VERSION"
  else
    echo "Will update all files using increment: $INCREMENT_TYPE"
  fi
  
  read -p "Do you want to continue? (y/n) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
  fi
fi

# Handle version updates based on increment type or specific version
if [ -n "$INCREMENT_TYPE" ]; then
  # For semantic increments
  echo "Incrementing version ($INCREMENT_TYPE)..."
  
  # Use npm version to increment the version
  npm version $INCREMENT_TYPE --no-git-tag-version
  
  # Get the new version
  NEW_VERSION=$(grep -o '"version": "[^"]*"' package.json | cut -d'"' -f4)
  
  # Update index.ts with the new version
  update_index_version "$INDEX_VERSION" "$NEW_VERSION"
  
  # Commit all changes and create tag
  git add package.json package-lock.json
  git commit -m "chore: release version $NEW_VERSION"
  git tag -a "v$NEW_VERSION" -m "Version $NEW_VERSION"
else
  # For specific version
  # Use npm version to update package.json and package-lock.json without git operations
  echo "Updating version in package.json and package-lock.json..."
  npm version $SPECIFIC_VERSION --no-git-tag-version
  
  # Update index.ts
  update_index_version "$INDEX_VERSION" "$SPECIFIC_VERSION"
  
  # Commit all changes and create tag
  git add package.json package-lock.json
  git commit -m "chore: release version $SPECIFIC_VERSION"
  git tag -a "v$SPECIFIC_VERSION" -m "Version $SPECIFIC_VERSION"
fi

# Get the final version for pushing the tag
FINAL_VERSION=$(grep -o '"version": "[^"]*"' package.json | cut -d'"' -f4)

# Push changes and tag to remote
echo "Pushing changes and tag to remote..."
git push origin main
git push origin v$FINAL_VERSION

echo "Release process completed for version $FINAL_VERSION"
echo "The GitHub workflow will now build and publish the package to npm"
echo "Check the Actions tab in your GitHub repository for progress" 