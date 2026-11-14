#!/bin/bash
#
# image/build.sh — bake the gpushed-cuda boot image.
#
# Creates a throwaway CPU-only VM from stock Ubuntu 22.04, runs the box setup
# (provisioner/terraform/scripts/setup.sh: NVIDIA driver, CUDA, Python, Node,
# Rust) as its startup script, waits for it to power off, saves its disk as a
# new image in the gpushed-cuda family, and deletes the VM. New boxes boot
# from the newest image in the family (provision.sh), so they skip setup.
#
# The driver needs no GPU to install: DKMS builds it for the kernel, and it
# loads on the box's GPU at boot. The builder gets no SSH access and no
# service account; progress and the result come back over the serial console.
#
# Run from GitHub (Actions > Build image) or by hand with gcloud signed in:
#   GCP_PROJECT=<project> image/build.sh
#
# Needs: compute.instanceAdmin.v1 and compute.storageAdmin on the project.

set -euo pipefail

: "${GCP_PROJECT:?set GCP_PROJECT}"
ZONE="${ZONE:-us-central1-a}"
REGION="${ZONE%-*}"
FAMILY="${FAMILY:-gpushed-cuda}"
KEEP="${KEEP:-3}" # images to keep in the family
VERSION="$(date -u +%Y%m%d-%H%M%S)"
NAME="$FAMILY-$VERSION"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REV="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
GC=(gcloud --project "$GCP_PROJECT" --quiet)

work=$(mktemp -d)
cleanup() {
  "${GC[@]}" compute instances delete "$NAME" --zone "$ZONE" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

# setup.sh is a Terraform template: undo its $${...} / %%{ escapes.
sed -e 's/\$\${/${/g' -e 's/%%{/%{/g' "$ROOT/provisioner/terraform/scripts/setup.sh" > "$work/setup.sh"

{
  cat <<'EOF'
#!/bin/bash
# Builder startup script (image/build.sh). Markers go to the serial console.
console() { echo "$*" > /dev/ttyS0 2>/dev/null || true; echo "$*"; }
[ -f /etc/gpushed-image ] && exit 0 # already built; don't redo on a reboot
cloud-init status --wait || true
cat > /tmp/setup.sh << 'GPUSHED_SETUP_EOF'
EOF
  cat "$work/setup.sh"
  cat <<EOF
GPUSHED_SETUP_EOF
if bash /tmp/setup.sh; then
  tail -3 /var/log/setup-script.log > /dev/ttyS0 2>/dev/null || true
  echo "$VERSION ($REV)" > /etc/gpushed-image
  # Leave nothing instance-specific behind: boxes get fresh logs, host keys
  # and cloud-init state on first boot.
  rm -f /var/log/setup-script.log /var/log/provisioning-completed /tmp/setup.sh
  rm -rf /var/lib/apt/lists/* /root/.cache /tmp/* /var/tmp/*
  apt-get clean
  cloud-init clean --logs || true
  rm -f /etc/ssh/ssh_host_*
  journalctl --rotate >/dev/null 2>&1 || true
  journalctl --vacuum-time=1s >/dev/null 2>&1 || true
  console GPUSHED_IMAGE_BUILD_OK
else
  tail -40 /var/log/setup-script.log > /dev/ttyS0 2>/dev/null || true
  console GPUSHED_IMAGE_BUILD_FAILED
fi
sync
shutdown -h now
EOF
} > "$work/startup.sh"

echo "▶ building $NAME in $ZONE (source $REV)"
"${GC[@]}" compute instances create "$NAME" \
  --zone "$ZONE" \
  --machine-type e2-standard-8 \
  --subnet "gpushed-$REGION" \
  --image-family ubuntu-2204-lts --image-project ubuntu-os-cloud \
  --boot-disk-size 40GB --boot-disk-type pd-balanced \
  --no-boot-disk-auto-delete \
  --no-service-account --no-scopes \
  --labels gpushed=image-builder \
  --metadata-from-file startup-script="$work/startup.sh" >/dev/null

# Delete the disk too once the image is made (or the build fails).
cleanup() {
  "${GC[@]}" compute instances delete "$NAME" --zone "$ZONE" >/dev/null 2>&1 || true
  "${GC[@]}" compute disks delete "$NAME" --zone "$ZONE" >/dev/null 2>&1 || true
  rm -rf "$work"
}

echo "… installing (driver, CUDA, Python, Node, Rust; usually 15-25 minutes)"
start=$SECONDS
while :; do
  status=$("${GC[@]}" compute instances describe "$NAME" --zone "$ZONE" --format='value(status)')
  [ "$status" = TERMINATED ] && break
  if [ $((SECONDS - start)) -gt 3000 ]; then
    echo "✗ timed out after 50 minutes; last console output:"
    "${GC[@]}" compute instances get-serial-port-output "$NAME" --zone "$ZONE" 2>/dev/null | tail -40
    exit 1
  fi
  sleep 30
  echo "  $(( (SECONDS - start) / 60 ))m $status"
done

serial=$("${GC[@]}" compute instances get-serial-port-output "$NAME" --zone "$ZONE" 2>/dev/null || true)
if ! grep -q GPUSHED_IMAGE_BUILD_OK <<<"$serial"; then
  echo "✗ setup failed; console output:"
  grep -v '^\s*$' <<<"$serial" | tail -60
  exit 1
fi
grep -E '^Installed:' <<<"$serial" | tail -1 || true

echo "… saving image $NAME"
"${GC[@]}" compute images create "$NAME" \
  --source-disk "$NAME" --source-disk-zone "$ZONE" \
  --family "$FAMILY" \
  --guest-os-features UEFI_COMPATIBLE,GVNIC,VIRTIO_SCSI_MULTIQUEUE \
  --labels gpushed=image \
  --description "gpushed box image: Ubuntu 22.04, NVIDIA driver 535, CUDA 12.6, Python 3.11, Node.js 24, Rust. Built from $REV." >/dev/null

# Keep the newest $KEEP images; boxes already created from older ones are unaffected.
"${GC[@]}" compute images list --no-standard-images --filter="family=$FAMILY" \
  --sort-by=~creationTimestamp --format='value(name)' | tail -n +$((KEEP + 1)) \
  | while read -r old; do
      echo "… deleting old image $old"
      "${GC[@]}" compute images delete "$old" >/dev/null
    done

echo "✔ $NAME is the newest $FAMILY image"
