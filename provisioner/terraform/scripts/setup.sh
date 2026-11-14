#!/bin/bash
set -e

# Box setup: NVIDIA driver + CUDA toolkit, plus the everyday toolchain
# (build tools, Python 3.11, Node.js LTS, Rust) so users can start right away.
# Normally baked into the gpushed-cuda image by image/build.sh, so a new box
# skips it; it only runs at boot on a box created from stock Ubuntu.
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
apt_retry install -y curl wget ca-certificates gnupg software-properties-common linux-headers-$(uname -r) dkms

# The NVIDIA module is built for this kernel. Keep unattended-upgrades from
# moving to a new kernel underneath it (security updates still apply).
cat > /etc/apt/apt.conf.d/51box-no-kernel-upgrades << 'UUCONF'
Unattended-Upgrade::Package-Blacklist { "linux-"; };
UUCONF

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

# Build the module for every installed kernel, not just the running one, so a
# kernel that unattended-upgrades pulled in before the hold above still boots
# with a working driver (this matters most when baking the image).
for k in $(ls /lib/modules); do
  apt_retry install -y "linux-headers-$k" || echo "WARNING: no headers for $k"
  dkms autoinstall -k "$k" || echo "WARNING: dkms failed for $k"
done

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

# ---------------------------------------------------------------- dev tools

echo "Installing build tools..."
apt_retry install -y build-essential git git-lfs cmake ninja-build pkg-config \
  unzip zip jq htop tmux tree rsync

# Python 3.11 (deadsnakes) alongside the system python3 (3.10, which Ubuntu's
# own tools need). `python` and `pip` mean 3.11; uv is there for fast venvs.
echo "Installing Python 3.11..."
add-apt-repository -y ppa:deadsnakes/ppa
apt_retry update -y
apt_retry install -y python3.11 python3.11-venv python3.11-dev
python3.11 -m ensurepip --upgrade
python3.11 -m pip install --no-cache-dir --upgrade pip
update-alternatives --install /usr/bin/python python /usr/bin/python3.11 1
ln -sf /usr/local/bin/pip3.11 /usr/local/bin/pip
curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh

# Node.js LTS (NodeSource)
echo "Installing Node.js 24 LTS..."
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt_retry install -y nodejs

# Rust (rustup, stable) for every user: toolchains in /opt/rust, each user's
# crates and `cargo install` binaries in their own ~/.cargo.
echo "Installing Rust..."
export RUSTUP_HOME=/opt/rust/rustup CARGO_HOME=/opt/rust/cargo
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile default
chmod -R a+rwX /opt/rust/rustup
for bin in /opt/rust/cargo/bin/*; do ln -sf "$bin" /usr/local/bin/; done
unset CARGO_HOME
# pam_env reads /etc/environment for every SSH session, login shell or not.
grep -q '^RUSTUP_HOME=' /etc/environment || echo 'RUSTUP_HOME=/opt/rust/rustup' >> /etc/environment
cat > /etc/profile.d/rust.sh << 'RUSTEOF'
export RUSTUP_HOME=/opt/rust/rustup
export PATH=$HOME/.cargo/bin:$PATH
RUSTEOF
chmod +x /etc/profile.d/rust.sh

echo "Installed: $(python --version), node $(node --version), $(rustc --version), $(/usr/local/cuda/bin/nvcc --version | tail -1)"
apt-get clean

echo "$(date): NVIDIA setup completed successfully" > /var/log/setup-completed
chmod 644 /var/log/setup-completed

echo "NVIDIA setup complete at $(date)!"
