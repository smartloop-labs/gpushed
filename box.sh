#!/bin/bash

set -e

GPUSHED_REPO="smartloop-labs/gpushed"

# Find the directory holding the Terraform files, following symlinks
# (e.g. ~/.local/bin/gpushed -> ~/.gpushed/box.sh). The SSH key, config and
# Terraform state live there too, so run everything from it.
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  LINK_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$LINK_DIR/$SOURCE"
done
BOX_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"

# How to refer to ourselves in messages: `gpushed` when on PATH, else as invoked.
PROG="$0"
if [ "$(command -v "$(basename "$0")" 2>/dev/null)" = "$0" ]; then
  PROG="$(basename "$0")"
fi

cd "$BOX_DIR"

box_version() {
  if [ -f "$BOX_DIR/VERSION" ]; then
    cat "$BOX_DIR/VERSION"
  else
    git -C "$BOX_DIR" describe --tags --always --dirty 2>/dev/null || echo "unknown"
  fi
}

# Download providers (if missing or the lock file changed). Quiet unless it fails.
tf_init() {
  local out
  if ! out=$(terraform init -input=false 2>&1); then
    echo "$out"
    echo "❌ terraform init failed"
    exit 1
  fi
}

# Create config/prod.tfvars from the example.
make_config() {
  mkdir -p config
  cp terraform.tfvars.example config/prod.tfvars
}

# The GPU box is billed to project_id, so it must never be the example's
# placeholder. When it is, ask for it, offering gcloud's current project as
# the default; without a terminal, use gcloud's project or stop.
require_project() {
  local current
  current=$(sed -n 's/^[[:space:]]*project_id[[:space:]]*=[[:space:]]*"\(.*\)".*/\1/p' config/prod.tfvars)
  if [ -n "$current" ] && [ "$current" != "your-gcp-project-id" ]; then
    return 0
  fi

  local gcloud_project project=""
  gcloud_project=$(gcloud config get-value project 2>/dev/null || true)

  if [ ! -t 0 ]; then
    if [ -z "$gcloud_project" ]; then
      echo "❌ project_id is not set in $BOX_DIR/config/prod.tfvars and gcloud has no current project."
      echo "   Set one with: $PROG config   (or: gcloud config set project <id>)"
      exit 1
    fi
    project="$gcloud_project"
    echo "🏷️  Using gcloud's current project: $project"
  else
    echo "🏷️  Which GCP project should the GPU box be created (and billed) in?"
    while true; do
      if [ -n "$gcloud_project" ]; then
        read -r -p "   GCP project ID [$gcloud_project]: " project
        project="${project:-$gcloud_project}"
      else
        read -r -p "   GCP project ID: " project
      fi
      if [[ $project =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]]; then
        break
      fi
      echo "   ❌ Not a valid project ID (6-30 chars: lowercase letters, digits, hyphens)"
    done
  fi

  if grep -q '^[[:space:]]*project_id[[:space:]]*=' config/prod.tfvars; then
    sed -i.bak "s/^[[:space:]]*project_id[[:space:]]*=.*/project_id         = \"$project\"/" config/prod.tfvars
    rm -f config/prod.tfvars.bak
  else
    printf 'project_id         = "%s"\n' "$project" >> config/prod.tfvars
  fi
  echo "   ✅ Saved to $BOX_DIR/config/prod.tfvars"
  echo ""
}

# Read a simple `name = value` setting from config/prod.tfvars.
tfvar() {
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*\"\{0,1\}\([^\"#]*\)\"\{0,1\}.*/\1/p" config/prod.tfvars \
    | head -1 | sed 's/[[:space:]]*$//'
}

# Zones to try, configured zone first, then the region's other zones that
# offer the machine type (and the GPU, when one is attached separately).
# Needs gcloud; without it, only the configured zone is tried.
candidate_zones() {
  local zone region project machine gpu_type gpu_count others
  zone=$(tfvar zone); region=$(tfvar region); project=$(tfvar project_id)
  machine=$(tfvar machine_type); gpu_type=$(tfvar gpu_type); gpu_count=$(tfvar gpu_count)
  echo "$zone"
  others=$(gcloud compute machine-types list --project="$project" \
    --filter="name=$machine AND zone~^$region-" --format="value(zone.basename())" 2>/dev/null) || return 0
  if [ "${gpu_count:-0}" != "0" ]; then
    local gpu_zones
    gpu_zones=$(gcloud compute accelerator-types list --project="$project" \
      --filter="name=$gpu_type AND zone~^$region-" --format="value(zone.basename())" 2>/dev/null) || return 0
    others=$(comm -12 <(echo "$others" | sort -u) <(echo "$gpu_zones" | sort -u))
  fi
  echo "$others" | sort -u | grep -v "^$zone\$" | grep -v '^$' || true
}

# terraform apply, moving to the next zone when GCP is out of capacity in
# the current one. The zone that works is saved to the config.
apply_with_zone_fallback() {
  local zones zone status log configured
  configured=$(tfvar zone)
  zones=$(candidate_zones)
  log=$(mktemp)
  for zone in $zones; do
    if [ "$zone" != "$configured" ]; then
      echo ""
      echo "🔁 Trying zone $zone..."
      echo ""
    fi
    terraform apply -var-file="config/prod.tfvars" -var="zone=$zone" -auto-approve 2>&1 | tee "$log"
    status=${PIPESTATUS[0]}
    if [ "$status" -eq 0 ]; then
      rm -f "$log"
      if [ "$zone" != "$configured" ]; then
        sed -i.bak "s/^[[:space:]]*zone[[:space:]]*=.*/zone               = \"$zone\"/" config/prod.tfvars
        rm -f config/prod.tfvars.bak
        echo ""
        echo "📍 Zone $configured was out of capacity; saved zone = \"$zone\" to $BOX_DIR/config/prod.tfvars"
      fi
      return 0
    fi
    if ! grep -qE 'STOCKOUT|ZONE_RESOURCE_POOL_EXHAUSTED|does not have enough resources available' "$log"; then
      rm -f "$log"
      return 1   # not a capacity problem; another zone won't help
    fi
    echo ""
    echo "⚠️  Zone $zone has no capacity for this machine right now."
  done
  rm -f "$log"
  echo ""
  echo "❌ No zone in $(tfvar region) has capacity right now (tried: $(echo $zones))."
  echo "   Try again later, another region, or a different GPU: $PROG config"
  return 1
}

COMMAND="${1:-}"

show_usage() {
  cat << EOF
Usage: $PROG COMMAND

Commands:
  init      Initialize project (generate SSH keys)
  up        Create and provision the VM instance
  setup     Manually run the startup script (install dependencies)
  down      Destroy the VM instance
  status    Show VM status and outputs
  ssh       SSH into the VM
  config    Edit the configuration (config/prod.tfvars)
  version   Show the installed version
  update    Update to the latest release
  help      Show this help message

Files (SSH key, config, Terraform state) live in: $BOX_DIR

Examples:
  $PROG init     # Generate SSH keys (first time)
  $PROG up       # Create VM
  $PROG setup    # Run installation script manually
  $PROG down     # Destroy VM
  $PROG status   # Show VM info
  $PROG ssh      # Connect to VM
EOF
}

case "$COMMAND" in
  init)
    echo "🔑 Initializing project..."

    # SSH key: keep an existing one unless asked to regenerate
    GENERATE_KEY=1
    if [ -f "./box_ssh_key" ]; then
      echo "⚠️  SSH key already exists at $BOX_DIR/box_ssh_key"
      read -p "Do you want to regenerate it? (y/N): " -n 1 -r
      echo
      if [[ $REPLY =~ ^[Yy]$ ]]; then
        rm -f ./box_ssh_key ./box_ssh_key.pub
      else
        echo "Keeping existing SSH key"
        GENERATE_KEY=0
      fi
    fi
    if [ "$GENERATE_KEY" = 1 ]; then
      echo "Generating SSH key pair..."
      ssh-keygen -t rsa -b 4096 -f ./box_ssh_key -N "" -C "gpushed"
    fi
    echo "   Private key: $BOX_DIR/box_ssh_key"
    echo "   Public key:  $BOX_DIR/box_ssh_key.pub"
    echo ""

    if [ ! -f "./config/prod.tfvars" ]; then
      echo "Creating $BOX_DIR/config/prod.tfvars from example..."
      make_config
    fi
    require_project

    echo "✅ Initialized."
    echo ""
    echo "Next steps:"
    echo "  1. Optionally review region, zone and GPU: $PROG config"
    echo "  2. Run: $PROG up"
    ;;
  
  up)
    # Auto-generate SSH key if it doesn't exist
    if [ ! -f "./box_ssh_key" ]; then
      echo "🔑 SSH key not found, generating..."
      ssh-keygen -t rsa -b 4096 -f ./box_ssh_key -N "" -C "gpushed"
      echo "  ✅ SSH key generated"
      echo ""
    fi
    
    # Auto-create config if it doesn't exist
    if [ ! -f "./config/prod.tfvars" ]; then
      echo "📝 Config not found, creating from template..."
      mkdir -p config
      if [ -f "./terraform.tfvars.example" ]; then
        make_config
        echo "  ✅ Created $BOX_DIR/config/prod.tfvars"
        echo ""
      else
        echo "❌ terraform.tfvars.example not found"
        exit 1
      fi
    fi
    
    # Check if scripts exist
    if [ ! -f "./scripts/setup.sh" ]; then
      echo "❌ Required scripts not found in ./scripts/"
      exit 1
    fi
    
    echo "📋 Pre-flight checks:"
    echo "  ✅ SSH key found"
    echo "  ✅ Configuration file found"
    echo "  ✅ Setup script found"
    echo ""
    
    require_project

    # Init must come first: workspace commands need the providers installed.
    tf_init

    # Create workspace based on SSH key hash
    echo "🔑 Setting up Terraform workspace..."
    SSH_KEY_HASH=$(ssh-keygen -lf ./box_ssh_key.pub | awk '{print $2}' | cut -d':' -f2 | cut -c1-8)
    WORKSPACE_NAME="box-${SSH_KEY_HASH}"
    
    # Select or create workspace
    if terraform workspace list | grep -q "$WORKSPACE_NAME"; then
      echo "  Selecting existing workspace: $WORKSPACE_NAME"
      terraform workspace select "$WORKSPACE_NAME"
    else
      echo "  Creating new workspace: $WORKSPACE_NAME"
      terraform workspace new "$WORKSPACE_NAME"
    fi
    echo ""
    
    echo "🚀 Creating VM instance with Terraform..."
    echo "   This will:"
    echo "   1. Create VM infrastructure"
    echo "   2. Run scripts/setup.sh (NVIDIA driver + CUDA)"
    echo ""
    
    if ! apply_with_zone_fallback; then
      echo ""
      echo "❌ VM creation failed. Check the error above."
      exit 1
    fi
    
    echo ""
    echo "✅ VM infrastructure created successfully!"
    echo ""
    
    # Get VM details
    VM_IP=$(terraform output -raw vm_public_ip 2>/dev/null)
    VM_DNS=$(terraform output -raw vm_dns_name 2>/dev/null)
    USERNAME=$(terraform output -raw admin_username 2>/dev/null || echo "admin")
    SSH_KEY="./box_ssh_key"
    
    echo "📊 VM Information:"
    terraform output
    echo ""
    
    # Clean up old SSH host keys (in case VM was recreated)
    echo "🧹 Cleaning up old SSH host keys..."
    ssh-keygen -R "$VM_IP" 2>/dev/null || true
    if [ -n "$VM_DNS" ] && [ "$VM_DNS" != "null" ]; then
      ssh-keygen -R "$VM_DNS" 2>/dev/null || true
    fi
    
    # Give VM a moment to initialize SSH after boot
    echo "⏱️  Waiting 10 seconds for VM to initialize..."
    sleep 10
    
    # Wait for VM to be accessible
    echo "⏳ Waiting for VM to be ready for SSH..."
    echo "   VM IP: $VM_IP"
    echo "   Username: $USERNAME"
    echo "   This usually takes 30-60 seconds..."
    echo ""
    
    RETRY=0
    MAX_RETRY=30
    SSH_OPTS="-i $SSH_KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=3 -o LogLevel=ERROR"
    
    while [ $RETRY -lt $MAX_RETRY ]; do
      # Try SSH directly (don't depend on nc which might not be available)
      SSH_EXIT=0
      SSH_OUTPUT=$(ssh $SSH_OPTS "$USERNAME@$VM_IP" "echo 'ready'" 2>&1) || SSH_EXIT=$?
      
      if [ $SSH_EXIT -eq 0 ]; then
        echo ""
        echo "✅ VM is accessible via SSH!"
        break
      fi
      
      # Show why SSH is failing
      if echo "$SSH_OUTPUT" | grep -qi "Permission denied"; then
        echo ""
        echo "❌ SSH authentication failed - check SSH keys"
        echo "   Expected key: $BOX_DIR/box_ssh_key.pub"
        echo "   Username: $USERNAME"
        echo ""
        echo "Public key content:"
        cat ./box_ssh_key.pub
        echo ""
        echo "SSH error output:"
        echo "$SSH_OUTPUT"
        exit 1
      elif echo "$SSH_OUTPUT" | grep -qi "Connection refused"; then
        echo "   SSH service not started yet... ($((RETRY+1))/$MAX_RETRY)"
      elif echo "$SSH_OUTPUT" | grep -qi "Connection timed out\|No route to host"; then
        echo "   Network not ready... ($((RETRY+1))/$MAX_RETRY)"
      else
        echo "   Connecting... ($((RETRY+1))/$MAX_RETRY) [Exit: $SSH_EXIT]"
      fi
      
      sleep 5
      RETRY=$((RETRY+1))
    done
    
    if [ $RETRY -ge $MAX_RETRY ]; then
      echo ""
      echo "❌ Timeout waiting for VM to be accessible after $((MAX_RETRY * 5)) seconds"
      echo ""
      echo "Troubleshooting:"
      echo "1. Check if VM is running:"
      echo "   gcloud compute instances describe $(terraform output -raw resource_name) --zone=$(terraform output -raw vm_zone)"
      echo ""
      echo "2. Check firewall allows SSH:"
      echo "   gcloud compute firewall-rules list --filter='name~ssh'"
      echo ""
      echo "3. Try manual SSH:"
      echo "   ssh -i $BOX_DIR/box_ssh_key $USERNAME@$VM_IP"
      echo ""
      echo "4. Check VM serial console output:"
      echo "   gcloud compute instances get-serial-port-output $(terraform output -raw resource_name) --zone=$(terraform output -raw vm_zone)"
      exit 1
    fi
    
    echo ""
    echo "🎉 VM created and accessible!"
    echo ""
    echo "📦 Running installation scripts (this takes 15-20 minutes)..."
    echo "   Installing: NVIDIA driver + CUDA toolkit"
    echo "   You'll see the output in real-time below."
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    
    # Trigger the metadata startup script and stream output
    echo "Running startup script..."
    SCRIPT_EXIT=0
    ssh $SSH_OPTS "$USERNAME@$VM_IP" "sudo google_metadata_script_runner startup" || SCRIPT_EXIT=$?
    
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    
    # Verify that provisioning actually completed
    if [ $SCRIPT_EXIT -eq 0 ]; then
      echo "Verifying installation completion..."
      if ssh $SSH_OPTS "$USERNAME@$VM_IP" "test -f /var/log/provisioning-completed"; then
        COMPLETION_MSG=$(ssh $SSH_OPTS "$USERNAME@$VM_IP" "cat /var/log/provisioning-completed")
        echo "✅ $COMPLETION_MSG"
        echo ""
        echo "🎉 Box provisioning complete!"
        echo ""
        echo "🔗 Connect to your box:"
        echo "   $PROG ssh"
        echo ""
        echo "📝 Verify installation:"
        echo "   nvidia-smi"
        echo "   nvcc --version"
      else
        echo "⚠️  Startup script finished but completion marker not found"
        echo ""
        echo "Check if installation actually completed:"
        echo "   $PROG ssh"
        echo "   cat /var/log/setup-completed"
        echo "   cat /var/log/install-completed"
        echo "   cat /var/log/provisioning-completed"
        exit 1
      fi
    else
      echo "❌ Installation failed!"
      echo ""
      echo "Check logs on the VM:"
      echo "   $PROG ssh"
      echo "   cat /var/log/setup-script.log"
      echo "   cat /var/log/install-script.log"
      echo ""
      echo "Check for completion markers:"
      echo "   cat /var/log/setup-completed"
      echo "   cat /var/log/install-completed"
      exit 1
    fi
    ;;
  
  setup)
    # Check if SSH key exists
    if [ ! -f "./box_ssh_key" ]; then
      echo "❌ SSH key not found."
      exit 1
    fi
    
    # Get VM details
    VM_IP=$(terraform output -raw vm_public_ip 2>/dev/null)
    USERNAME=$(terraform output -raw admin_username 2>/dev/null || echo "boxuser")
    SSH_KEY="./box_ssh_key"
    SSH_OPTS="-i $SSH_KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=3 -o LogLevel=ERROR"
    
    if [ -z "$VM_IP" ] || [ "$VM_IP" == "null" ]; then
      echo "❌ No VM found. Run '$PROG up' first."
      exit 1
    fi
    
    echo "📦 Running startup script on VM..."
    echo "   VM: $VM_IP"
    echo "   This will install: NVIDIA driver + CUDA toolkit"
    echo "   This takes 15-20 minutes."
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    
    # Trigger the metadata startup script
    if ssh $SSH_OPTS "$USERNAME@$VM_IP" "sudo google_metadata_script_runner startup"; then
      echo ""
      echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
      echo ""
      
      # Verify completion
      if ssh $SSH_OPTS "$USERNAME@$VM_IP" "test -f /var/log/provisioning-completed"; then
        COMPLETION_MSG=$(ssh $SSH_OPTS "$USERNAME@$VM_IP" "cat /var/log/provisioning-completed")
        echo "✅ $COMPLETION_MSG"
        echo ""
        echo "🎉 Setup complete!"
      else
        echo "⚠️  Script finished but completion marker not found"
      fi
    else
      echo ""
      echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
      echo ""
      echo "❌ Setup failed!"
      echo ""
      echo "Check logs: $PROG ssh"
      echo "  cat /var/log/setup-script.log"
      echo "  cat /var/log/install-script.log"
      exit 1
    fi
    ;;
  
  down)
    tf_init

    # Get workspace from SSH key
    if [ -f "./box_ssh_key.pub" ]; then
      SSH_KEY_HASH=$(ssh-keygen -lf ./box_ssh_key.pub | awk '{print $2}' | cut -d':' -f2 | cut -c1-8)
      WORKSPACE_NAME="box-${SSH_KEY_HASH}"
      
      # Select workspace if it exists
      if terraform workspace list | grep -q "$WORKSPACE_NAME"; then
        terraform workspace select "$WORKSPACE_NAME" 2>/dev/null || true
      fi
    fi
    
    echo "🗑️  Destroying VM instance..."
    terraform destroy -var-file="config/prod.tfvars" -auto-approve
    echo "✅ VM destroyed successfully!"
    ;;
  
  status)
    tf_init

    # Get workspace from SSH key
    if [ -f "./box_ssh_key.pub" ]; then
      SSH_KEY_HASH=$(ssh-keygen -lf ./box_ssh_key.pub | awk '{print $2}' | cut -d':' -f2 | cut -c1-8)
      WORKSPACE_NAME="box-${SSH_KEY_HASH}"
      
      # Select workspace if it exists
      if terraform workspace list | grep -q "$WORKSPACE_NAME"; then
        terraform workspace select "$WORKSPACE_NAME" 2>/dev/null || true
      fi
    fi
    
    echo "📊 VM Status:"
    echo "Workspace: $(terraform workspace show)"
    echo ""
    terraform output
    ;;
  
  ssh)
    VM_IP=$(terraform output -raw vm_public_ip 2>/dev/null)
    USERNAME=$(terraform output -raw admin_username 2>/dev/null || echo "admin")
    SSH_KEY="./box_ssh_key"
    
    if [ -z "$VM_IP" ]; then
      echo "❌ Could not get VM IP. Is the VM running?"
      exit 1
    fi
    
    if [ ! -f "$SSH_KEY" ]; then
      echo "❌ SSH key not found at $SSH_KEY"
      echo "Generate it with: $PROG init"
      exit 1
    fi
    
    echo "🔗 Connecting to VM..."
    ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null "$USERNAME@$VM_IP"
    ;;
  
  config)
    if [ ! -f "./config/prod.tfvars" ]; then
      mkdir -p config
      make_config
    fi
    "${EDITOR:-vi}" "$BOX_DIR/config/prod.tfvars"
    ;;

  version|--version|-v)
    box_version
    ;;

  update)
    if [ -d "$BOX_DIR/.git" ]; then
      echo "This is a git checkout; update it with: git -C \"$BOX_DIR\" pull"
      exit 1
    fi
    echo "⬆️  Updating gpushed (currently $(box_version))..."
    curl -fsSL "https://github.com/$GPUSHED_REPO/releases/latest/download/install.sh" | GPUSHED_HOME="$BOX_DIR" bash
    ;;

  help|-h|--help|"")
    show_usage
    ;;
  
  *)
    echo "❌ Unknown command: $COMMAND"
    echo ""
    show_usage
    exit 1
    ;;
esac
