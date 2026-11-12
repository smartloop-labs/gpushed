#!/bin/bash
#
# Install gpushed from its GitHub release:
#
#   curl -fsSL https://github.com/smartloop-labs/gpushed/releases/latest/download/install.sh | bash
#
# Environment:
#   GPUSHED_VERSION   Release tag to install, e.g. v0.1.0 (default: latest)
#   GPUSHED_HOME      Install directory; also holds your SSH key, config and
#                     Terraform state (default: ~/.gpushed)
#   GPUSHED_BIN_DIR   Where the `gpushed` command is linked (default: ~/.local/bin)
#
# Re-running it upgrades in place and keeps your key, config and state.

set -euo pipefail

# Everything is inside main so a partially downloaded script never runs.
main() {
  local repo="smartloop-labs/gpushed"
  local version="${GPUSHED_VERSION:-latest}"
  local home="${GPUSHED_HOME:-$HOME/.gpushed}"
  local bin_dir="${GPUSHED_BIN_DIR:-$HOME/.local/bin}"
  local asset="gpushed.tar.gz"
  for cmd in curl tar; do
    command -v "$cmd" >/dev/null 2>&1 || fail "$cmd is required"
  done

  # Resolve "latest" to a tag once, so the package and its checksum come
  # from the same release even while GitHub's "latest" redirect is updating.
  if [ "$version" = "latest" ]; then
    version="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$repo/releases/latest")" \
      || fail "could not look up the latest release"
    version="${version##*/}"
    case "$version" in
      v*) ;;
      *) fail "could not determine the latest release" ;;
    esac
  fi
  local base="https://github.com/$repo/releases/download/$version"

  GPUSHED_TMP="$(mktemp -d)"
  trap 'rm -rf "$GPUSHED_TMP"' EXIT
  local tmp="$GPUSHED_TMP"

  say "Downloading gpushed ($version)..."
  curl -fsSL "$base/$asset" -o "$tmp/$asset" \
    || fail "could not download $base/$asset"
  curl -fsSL "$base/$asset.sha256" -o "$tmp/$asset.sha256" \
    || fail "could not download $base/$asset.sha256"

  say "Verifying checksum..."
  local expected actual
  expected="$(awk '{print $1}' "$tmp/$asset.sha256")"
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$tmp/$asset" | awk '{print $1}')"
  else
    actual="$(shasum -a 256 "$tmp/$asset" | awk '{print $1}')"
  fi
  [ -n "$expected" ] && [ "$expected" = "$actual" ] \
    || fail "checksum mismatch for $asset (expected $expected, got $actual)"

  mkdir -p "$tmp/src"
  tar -xzf "$tmp/$asset" -C "$tmp/src"
  local src="$tmp/src/gpushed"
  [ -f "$src/box.sh" ] || fail "unexpected archive layout"

  # Remove files the previous release shipped that this one no longer does.
  # Only files listed in the old manifest are touched, never your key, config
  # or state.
  if [ -f "$home/.manifest" ]; then
    while IFS= read -r f; do
      [ -n "$f" ] && [ ! -e "$src/$f" ] && rm -f "$home/$f"
    done < "$home/.manifest"
  fi

  mkdir -p "$home"
  (cd "$src" && find . -type f | sed 's|^\./||' | sort) > "$src/.manifest"
  cp -R "$src/." "$home/"
  chmod +x "$home/box.sh"

  mkdir -p "$bin_dir"
  ln -sf "$home/box.sh" "$bin_dir/gpushed"

  say ""
  say "✅ Installed gpushed $(cat "$home/VERSION") to $home"
  say "   Command: $bin_dir/gpushed"

  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *)
      say ""
      say "⚠️  $bin_dir is not on your PATH. Add this to your shell profile:"
      say "   export PATH=\"$bin_dir:\$PATH\""
      ;;
  esac

  local missing=()
  command -v terraform >/dev/null 2>&1 || missing+=("terraform (https://developer.hashicorp.com/terraform/install)")
  command -v gcloud >/dev/null 2>&1 || missing+=("gcloud (https://cloud.google.com/sdk/docs/install)")
  if [ ${#missing[@]} -gt 0 ]; then
    say ""
    say "⚠️  gpushed also needs:"
    for m in "${missing[@]}"; do say "   - $m"; done
  fi

  say ""
  say "Next steps:"
  say "   gpushed init      # create an SSH key and config"
  say "   gpushed config    # set project_id (and region/zone)"
  say "   gpushed up        # create the GPU box"
}

say() { printf '%s\n' "$*"; }
fail() { printf '❌ %s\n' "$*" >&2; exit 1; }

main "$@"
