#!/bin/bash
set -e

echo ""
echo "=========================================="
echo "       GPU BOX PROVISIONING"
echo "=========================================="
echo "Starting provisioning at $(date)..."
echo ""

# Both the boot-time startup service and `box.sh up` (over SSH) invoke this
# script. Serialize them so only one provisions; the other waits, then exits.
exec 9>/var/lock/box-provision.lock
if ! flock -n 9; then
  echo "Provisioning already running in another process; waiting for it..."
  flock 9
fi
if [ -f /var/log/provisioning-completed ]; then
  echo "Already provisioned: $(cat /var/log/provisioning-completed)"
  exit 0
fi

# Wait for cloud-init to complete
cloud-init status --wait || true

echo "Running setup script..."
cat > /tmp/setup.sh << 'SETUPSCRIPT'
${setup_script}
SETUPSCRIPT

bash /tmp/setup.sh

echo "$(date): Provisioning completed" > /var/log/provisioning-completed
echo "Provisioning complete!"

