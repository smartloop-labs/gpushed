#!/bin/bash
#
# Install gpushed:
#
#   curl -fsSL gpushed.smartloop.ai/install.sh | bash
#
# gpushed runs on Macs with Apple silicon and macOS 26+, using Apple's native
# `container` runtime. Releases are served from Cloudflare R2.
#
# Environment:
#   GPUSHED_VERSION   Release to install, e.g. v0.2.0 (default: latest)
#   GPUSHED_HOME      Install directory; also holds your API token and SSH key
#                     (default: ~/.gpushed)
#   GPUSHED_BIN_DIR   Where the `gpushed` command is linked (default: ~/.local/bin)
#   GPUSHED_DL        Release download base (default: https://dl.gpushed.smartloop.ai)
#   GPUSHED_NO_INIT   Set to 1 to skip running `gpushed init` afterwards
#
# Re-running it upgrades in place and keeps your sign-in and SSH key.

set -euo pipefail

# Everything is inside main so a partially downloaded script never runs.
main() {
  local dl="${GPUSHED_DL:-https://dl.gpushed.smartloop.ai}"
  local version="${GPUSHED_VERSION:-latest}"
  local home="${GPUSHED_HOME:-$HOME/.gpushed}"
  local bin_dir="${GPUSHED_BIN_DIR:-$HOME/.local/bin}"
  local asset="gpushed.tar.gz"

  [ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] \
    || fail "gpushed supports Macs with Apple silicon only (it runs on Apple's native container runtime)."
  local major
  major="$(sw_vers -productVersion | cut -d. -f1)"
  [ "$major" -ge 26 ] || fail "gpushed needs macOS 26 or later (you have $(sw_vers -productVersion))."

  if [ "$version" = "latest" ]; then
    version="$(curl -fsSL "$dl/latest")" || fail "could not look up the latest release"
    case "$version" in v*) ;; *) fail "could not determine the latest release" ;; esac
  fi

  GPUSHED_TMP="$(mktemp -d)"
  trap 'rm -rf "$GPUSHED_TMP"' EXIT
  local tmp="$GPUSHED_TMP"

  say "Downloading gpushed ($version)..."
  curl -fsSL "$dl/$version/$asset" -o "$tmp/$asset" || fail "could not download $dl/$version/$asset"
  curl -fsSL "$dl/$version/$asset.sha256" -o "$tmp/$asset.sha256" || fail "could not download the checksum"

  say "Verifying checksum..."
  local expected actual
  expected="$(awk '{print $1}' "$tmp/$asset.sha256")"
  actual="$(shasum -a 256 "$tmp/$asset" | awk '{print $1}')"
  [ -n "$expected" ] && [ "$expected" = "$actual" ] \
    || fail "checksum mismatch for $asset (expected $expected, got $actual)"

  mkdir -p "$tmp/src"
  tar -xzf "$tmp/$asset" -C "$tmp/src"
  local src="$tmp/src/gpushed"
  [ -f "$src/gpushed" ] || fail "unexpected archive layout"

  # Earlier versions ran Terraform on this Mac against your own GCP project.
  if [ -d "$home/terraform.tfstate.d" ] || [ -f "$home/terraform.tfstate" ]; then
    say ""
    say "⚠️  Found Terraform state from an older gpushed that used your own GCP project."
    say "   If that box still exists, delete it in the GCP console (Compute Engine > VM instances)."
    say "   Old files are left in $home."
  fi

  # Remove files the previous release shipped that this one no longer does.
  # Only files in the old manifest are touched, never your token or key.
  if [ -f "$home/.manifest" ]; then
    while IFS= read -r f; do
      [ -n "$f" ] && [ ! -e "$src/$f" ] && rm -f "$home/$f"
    done < "$home/.manifest"
  fi

  mkdir -p "$home"
  (cd "$src" && find . -type f | sed 's|^\./||' | sort) > "$src/.manifest"
  cp -R "$src/." "$home/"
  chmod +x "$home/gpushed"
  rm -f "$home/box.sh"

  mkdir -p "$bin_dir"
  ln -sf "$home/gpushed" "$bin_dir/gpushed"

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

  # Set up Apple's container runtime and sign in right away when someone is
  # at the keyboard (stdin is this script when piped from curl, so use the tty).
  if [ "${GPUSHED_NO_INIT:-0}" != 1 ] && { : </dev/tty; } 2>/dev/null; then
    say ""
    "$home/gpushed" init </dev/tty || say "⚠️  Setup didn't finish; run it again with: gpushed init"
    say ""
    say "Next steps:"
    say "   gpushed topup     # add credit (minimum \$10)"
    say "   gpushed up        # create your GPU box"
  else
    say ""
    say "Next steps:"
    say "   gpushed init      # install Apple's container runtime and sign in"
    say "   gpushed topup     # add credit (minimum \$10)"
    say "   gpushed up        # create your GPU box"
  fi
}

say() { printf '%s\n' "$*"; }
fail() { printf '❌ %s\n' "$*" >&2; exit 1; }

main "$@"
