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
# User-installed tools (pip --user, uv tool, docent's installer, ...) land in
# ~/.local/bin. Ubuntu's ~/.profile adds it only if it existed at login, and
# the box user may have no rc files at all, so put it on PATH for every login
# shell up front: a fresh install then works without restarting the shell.
# Runs on every boot, so boxes made from an older image pick it up too.
cat > /etc/profile.d/local-bin.sh << 'LOCALBINEOF'
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac
LOCALBINEOF
chmod 644 /etc/profile.d/local-bin.sh
# Login shells read /etc/profile.d, but VS Code/Cursor remote terminals,
# `gpushed ssh <command>` and some tmux setups start non-login bash, which
# reads /etc/bash.bashrc instead. Source the same file from its first line,
# ahead of its early return for non-interactive shells, so those get
# ~/.local/bin too (and docent's installer stops asking to source ~/.bashrc).
grep -q 'profile.d/local-bin.sh' /etc/bash.bashrc 2>/dev/null \
  || sed -i '1i [ -r /etc/profile.d/local-bin.sh ] \&\& . /etc/profile.d/local-bin.sh # gpushed' /etc/bash.bashrc

if [ -f /var/log/provisioning-completed ]; then
  echo "Already provisioned: $(cat /var/log/provisioning-completed)"
  exit 0
fi

# Booted from the prebuilt gpushed-cuda image (image/build.sh): the driver,
# CUDA and dev tools are already installed. Just check the GPU and finish.
if [ -f /etc/gpushed-image ]; then
  {
    echo "Prebuilt image $(cat /etc/gpushed-image): NVIDIA driver, CUDA, Python, Node.js and Rust are installed."
    # The driver is on the disk; it only needs its kernel module loaded. If
    # the module wasn't built for this kernel, rebuild it (a minute or two)
    # rather than reinstalling everything.
    if ! { modprobe nvidia && nvidia-smi >/dev/null 2>&1; }; then
      echo "NVIDIA module not loaded for kernel $(uname -r); rebuilding it..."
      export DEBIAN_FRONTEND=noninteractive
      apt-get -o Acquire::ForceIPv4=true update -y >/dev/null 2>&1 || true
      apt-get -o Acquire::ForceIPv4=true install -y "linux-headers-$(uname -r)" || true
      dkms autoinstall -k "$(uname -r)" || true
      modprobe nvidia || true
    fi
    modprobe nvidia-uvm || true
    nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv \
      || echo "WARNING: nvidia-smi failed. If it persists, sudo reboot once."
  } >> /var/log/setup-script.log 2>&1
  echo "$(date): Provisioning completed (prebuilt image $(cat /etc/gpushed-image))" > /var/log/provisioning-completed
  echo "Provisioning complete!"
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

