#!/bin/bash
set -e

# NVIDIA-only box setup: GPU driver + CUDA toolkit. Nothing else.
# NOTE: rendered by Terraform templatefile(); escape shell vars as $${var}.

LOGFILE="/var/log/setup-script.log"
exec 1> >(tee -a "$LOGFILE")
exec 2>&1

echo "Starting NVIDIA setup at $(date)..."

dpkg --configure -a || echo "WARNING: dpkg configure reported issues, continuing..."

# Retry apt-get, waiting for apt/dpkg locks (unattended-upgrades runs on first boot)
apt_retry() {
  local n=0 max=10 delay=15
  local locks="/var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock /var/cache/apt/archives/lock"
  until [ "$n" -ge "$max" ]; do
    local waited=0
    while fuser $locks >/dev/null 2>&1 && [ $waited -lt 120 ]; do
      sleep 2
      waited=$((waited + 2))
    done
    if apt-get "$@"; then
      return 0
    fi
    n=$((n + 1))
    echo "apt-get $* failed. Retrying in $delay seconds... ($n/$max)"
    sleep $delay
    delay=$((delay + 5))
  done
  echo "apt-get $* failed after $max attempts."
  return 1
}

export DEBIAN_FRONTEND=noninteractive

# GCE VMs have no IPv6 route; without ForceIPv4 apt tries every IPv6 mirror
# address first and `apt-get update` takes many minutes. Ubuntu's mirrors can
# also stall from GCE: time out fast and retry instead of hanging on one fetch.
cat > /etc/apt/apt.conf.d/99box-network << 'APTCONF'
Acquire::ForceIPv4 "true";
Acquire::Retries "5";
Acquire::http::Timeout "20";
Acquire::https::Timeout "20";
APTCONF

apt_retry update -y
apt_retry install -y curl wget linux-headers-$(uname -r) dkms

# Runtime libraries common local-inference apps (llama.cpp/Vulkan builds such
# as docent) link against; the stock image lacks them.
apt_retry install -y libfontconfig1 libvulkan1 libgomp1

# NVIDIA driver
echo "Installing NVIDIA driver 535..."
apt_retry install -y nvidia-driver-535-server nvidia-utils-535-server

if ! dpkg -l | grep -q "^ii.*nvidia-driver-535-server"; then
  echo "ERROR: NVIDIA driver installation failed"
  exit 1
fi

modprobe nvidia || true
modprobe nvidia-uvm || true
nvidia-smi || echo "WARNING: nvidia-smi failed. A reboot may be required."

# CUDA toolkit
echo "Installing CUDA Toolkit 12.6..."
wget -q https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2204/x86_64/cuda-keyring_1.1-1_all.deb -O /tmp/cuda-keyring.deb
dpkg -i /tmp/cuda-keyring.deb
apt_retry update -y
apt_retry install -y cuda-toolkit-12-6

cat > /etc/profile.d/cuda.sh << 'CUDAEOF'
export PATH=/usr/local/cuda/bin:$PATH
export LD_LIBRARY_PATH=/usr/local/cuda/lib64:$LD_LIBRARY_PATH
CUDAEOF
chmod +x /etc/profile.d/cuda.sh

echo "$(date): NVIDIA setup completed successfully" > /var/log/setup-completed
chmod 644 /var/log/setup-completed

echo "NVIDIA setup complete at $(date)!"
