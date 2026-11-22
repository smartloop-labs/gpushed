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

# Idle watcher: once the GPU has had nothing running on it, and nobody has been
# connected over SSH, for gpushed-idle-minutes (instance metadata), ask the
# gpushed API to stop this box, as `gpushed stop` would: the disk is kept and
# `gpushed start` resumes it. Checks every minute; installed on every boot.
# (No dollar-brace expansions here: this file is a Terraform template.)
cat > /usr/local/sbin/gpushed-idle << 'IDLEEOF'
#!/bin/bash
md() { curl -fs -m 5 -H 'Metadata-Flavor: Google' "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1"; }
API=$(md gpushed-api) || exit 0
BOX=$(md gpushed-box-id) || exit 0
TOKEN=$(md gpushed-idle-token) || exit 0
MINUTES=$(md gpushed-idle-minutes) || MINUTES=5
[ -n "$API" ] && [ -n "$BOX" ] && [ -n "$TOKEN" ] || exit 0
case "$MINUTES" in '' | *[!0-9]*) MINUTES=5 ;; esac
[ "$MINUTES" -gt 0 ] || exit 0

STATE=/run/gpushed-idle # last busy time; /run is cleared on boot
now=$(date +%s)
busy=0
# Still setting up (a stock image installs the driver on first boot).
[ -f /var/log/provisioning-completed ] || busy=1
# Anything on the GPU: a process holding it, or utilization of 5% or more.
if [ -n "$(nvidia-smi --query-compute-apps=pid --format=csv,noheader 2>/dev/null)" ]; then busy=1; fi
for u in $(nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits 2>/dev/null); do
  case "$u" in *[!0-9]*) ;; *) [ "$u" -ge 5 ] && busy=1 ;; esac
done
# Someone connected: a shell, VS Code or Cursor, a copy, a tunnel.
if ss -Htn state established '( sport = :22 )' 2>/dev/null | grep -q .; then busy=1; fi

if [ "$busy" = 1 ] || [ ! -f "$STATE" ]; then
  echo "$now" > "$STATE"
  exit 0
fi
since=$(cat "$STATE")
[ $((now - since)) -ge $((MINUTES * 60)) ] || exit 0
logger -t gpushed-idle "GPU idle for $MINUTES minutes; asking gpushed to stop this box"
if out=$(curl -fsS -m 20 -X POST -H "authorization: Bearer $TOKEN" "$API/boxes/$BOX/idle" 2>&1); then
  logger -t gpushed-idle "$out"
else
  logger -t gpushed-idle "stop request failed ($out); retrying next minute"
fi
IDLEEOF
chmod 755 /usr/local/sbin/gpushed-idle
cat > /etc/systemd/system/gpushed-idle.service << 'IDLEEOF'
[Unit]
Description=Stop this gpushed box when its GPU is idle

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/gpushed-idle
IDLEEOF
cat > /etc/systemd/system/gpushed-idle.timer << 'IDLEEOF'
[Unit]
Description=Check every minute whether this gpushed box is idle

[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
AccuracySec=10s

[Install]
WantedBy=timers.target
IDLEEOF
systemctl daemon-reload
systemctl enable --now gpushed-idle.timer || echo "WARNING: could not start the idle watcher"

# ---------------------------------------------------------------- shell look
# The GPU Shed login banner, a minimal Starship prompt in Omarchy's Osaka
# Jade colors, and Hack Nerd Font. Runs on every boot and skips what's already
# installed; a failed download never fails provisioning.
# (No dollar-brace expansions here: this file is a Terraform template.)
gpushed_shell_look() {
  mkdir -p /etc/gpushed

  # GPU name for the banner and the prompt, cached in /run (cleared on boot).
  # The login banner (run as root) refreshes it if the driver came up later.
  nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null \
    | head -1 | sed 's/^NVIDIA //' > /run/gpushed-gpu || true
  [ -s /run/gpushed-gpu ] || rm -f /run/gpushed-gpu

  # Login banner: shown on `gpushed ssh` and any interactive SSH login.
  cat > /etc/update-motd.d/00-gpushed << 'MOTDEOF'
#!/bin/sh
# gpushed: GPU Shed login banner (Osaka Jade colors).
if [ ! -s /run/gpushed-gpu ]; then
  nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null \
    | head -1 | sed 's/^NVIDIA //' > /run/gpushed-gpu 2>/dev/null || true
fi
gpu=$(cat /run/gpushed-gpu 2>/dev/null)
J='\033[38;2;80;148;117m'   # jade    #509475
M='\033[38;2;99;176;122m'   # mint    #63b07a
T='\033[38;2;45;213;183m'   # teal    #2DD5B7
S='\033[38;2;215;201;149m'  # sand    #D7C995
D='\033[38;2;83;104;91m'    # slate   #53685B
R='\033[0m'
printf '\n'
printf "$J"'   ____ ____  _   _   '"$M"' ____  _   _ _____ ____  '"$R"'\n'
printf "$J"'  / ___|  _ \\| | | |  '"$M"'/ ___|| | | | ____|  _ \\ '"$R"'\n'
printf "$J"' | |  _| |_) | | | |  '"$M"'\\___ \\| |_| |  _| | | | |'"$R"'\n'
printf "$J"' | |_| |  __/| |_| |  '"$M"' ___) |  _  | |___| |_| |'"$R"'\n'
printf "$J"'  \\____|_|    \\___/   '"$M"'|____/|_| |_|_____|____/ '"$R"'\n'
printf '\n'
[ -n "$gpu" ] && printf "  $T"'GPU '"$S"'%s'"$R"'\n' "$gpu"
printf "  $D"'CUDA 12.6 · Python 3.11 · Node.js 24 · Rust · gpushed.dev'"$R"'\n\n'
MOTDEOF
  chmod 755 /etc/update-motd.d/00-gpushed

  # Starship prompt.
  if ! command -v starship >/dev/null 2>&1; then
    curl -fsSL -m 60 https://starship.rs/install.sh -o /tmp/starship-install.sh \
      && sh /tmp/starship-install.sh -y -b /usr/local/bin >/dev/null \
      || echo "WARNING: could not install Starship"
    rm -f /tmp/starship-install.sh
  fi

  # Minimal two-line prompt in Osaka Jade: GPU, directory, git, slow-command
  # time, then the input line. Plain text, so no Nerd Font is needed.
  cat > /etc/gpushed/starship.toml << 'STARSHIPEOF'
"$schema" = "https://starship.rs/config-schema.json"
# gpushed: a minimal Starship prompt in Omarchy's Osaka Jade colors.
#   L4 ~/llm-finetune on main ? took 5s
#   ❯
# Make your own with ~/.config/starship.toml (it takes precedence over this
# file), or set GPUSHED_NO_STARSHIP=1 for the plain bash prompt.

palette = "osaka_jade"
add_newline = true
format = "$custom$directory$git_branch$git_status$cmd_duration$line_break$character"

[palettes.osaka_jade]
slate = "#53685B"
jade = "#509475"
mint = "#63b07a"
teal = "#2DD5B7"
sand = "#D7C995"
coral = "#FF5345"

[custom.gpu]
command = "cut -d, -f1 /run/gpushed-gpu"
when = "test -s /run/gpushed-gpu"
shell = ["sh"]
style = "bold teal"
format = "[$output]($style) "

[directory]
style = "bold jade"
truncation_length = 3
format = "[$path]($style)[$read_only]($read_only_style) "

[git_branch]
style = "sand"
format = "on [$branch]($style) "

[git_status]
style = "sand"
format = "([$all_status$ahead_behind]($style) )"

[cmd_duration]
min_time = 2000
style = "slate"
format = "took [$duration]($style)"

[character]
success_symbol = "[❯](bold mint)"
error_symbol = "[❯](bold coral)"
STARSHIPEOF
  chmod 644 /etc/gpushed/starship.toml

  # Every interactive bash (login or not, so VS Code terminals too) gets the
  # prompt, unless the user has their own Starship config or opts out with
  # GPUSHED_NO_STARSHIP=1.
  if ! grep -q 'gpushed starship' /etc/bash.bashrc 2>/dev/null; then
    cat >> /etc/bash.bashrc << 'BASHRCEOF'

# gpushed starship: Osaka Jade prompt (see /etc/gpushed/starship.toml).
if command -v starship >/dev/null 2>&1 && [ -z "$GPUSHED_NO_STARSHIP" ] && [ "$TERM" != dumb ]; then
  [ -f "$HOME/.config/starship.toml" ] || export STARSHIP_CONFIG=/etc/gpushed/starship.toml
  eval "$(starship init bash)"
fi
BASHRCEOF
  fi

  # Hack Nerd Font, for anything rendered on the box itself.
  if [ ! -d /usr/local/share/fonts/HackNerdFont ]; then
    mkdir -p /usr/local/share/fonts/HackNerdFont
    if curl -fsSL -m 120 https://github.com/ryanoasis/nerd-fonts/releases/latest/download/Hack.tar.xz -o /tmp/hack-nf.tar.xz \
       && tar -xJf /tmp/hack-nf.tar.xz -C /usr/local/share/fonts/HackNerdFont --wildcards '*.ttf'; then
      command -v fc-cache >/dev/null 2>&1 && fc-cache -f /usr/local/share/fonts/HackNerdFont >/dev/null 2>&1
    else
      echo "WARNING: could not install Hack Nerd Font"
      rm -rf /usr/local/share/fonts/HackNerdFont
    fi
    rm -f /tmp/hack-nf.tar.xz
  fi
}
gpushed_shell_look || echo "WARNING: shell setup (banner, Starship, font) didn't finish"

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

