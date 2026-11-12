# gpushed

Your own GPU shed: spin up an NVIDIA GPU box on Google Cloud with one command, with no
waitlist and no day-long queue for capacity. You get a clean Ubuntu 22.04 VM with
the NVIDIA driver and CUDA installed, an SSH key, and a static IP. Tear it
down when you're done so you only pay for the hours you use.

Install:

```bash
curl -fsSL https://github.com/smartloop-labs/gpushed/releases/latest/download/install.sh | bash
```

Then:

```bash
gpushed up       # create the VM and install the NVIDIA driver + CUDA
gpushed ssh      # connect
nvidia-smi       # on the box
gpushed down     # destroy everything
```

## What you get

- A GCE VM (default `a2-highgpu-1g`: 1× A100 40 GB) on Ubuntu 22.04
- NVIDIA driver 535 (server) and CUDA Toolkit 12.6. Nothing else: no Python
  stack, no frameworks, so the box stays yours to set up
- A few runtime libraries local-inference apps commonly need
  (`libvulkan1`, `libgomp1`, `libfontconfig1`)
- Its own VPC, subnet, SSH-only firewall rule and static external IP
- Optionally, a DNS A record in a Cloud DNS zone you already have

## Prerequisites

- A GCP project with billing enabled and **GPU quota** in your region
  (IAM & Admin → Quotas → filter for the GPU, e.g. `NVIDIA_A100_GPUS`)
- [Terraform](https://developer.hashicorp.com/terraform/install) ≥ 1.0.1
- [Google Cloud SDK](https://cloud.google.com/sdk/docs/install), authenticated:
  ```bash
  gcloud auth application-default login
  ```

## Install

```bash
curl -fsSL https://github.com/smartloop-labs/gpushed/releases/latest/download/install.sh | bash
```

This downloads the latest release into `~/.gpushed`, verifies its SHA-256
checksum and links the `gpushed` command into `~/.local/bin`. Your SSH key,
config and Terraform state also live in `~/.gpushed`, and survive upgrades.

| Variable | Description | Default |
|---|---|---|
| `GPUSHED_VERSION` | Release tag to install, e.g. `v0.1.0` | latest |
| `GPUSHED_HOME` | Install directory (also holds key, config, state) | `~/.gpushed` |
| `GPUSHED_BIN_DIR` | Where the `gpushed` command is linked | `~/.local/bin` |

Upgrade with `gpushed update`. To uninstall, run `gpushed down` first, then
`rm -rf ~/.gpushed ~/.local/bin/gpushed`.

Prefer a checkout? `git clone https://github.com/smartloop-labs/gpushed.git`
and use `./box.sh` in place of `gpushed`; everything works the same.

## Quick start

```bash
gpushed init      # generates an SSH key and config/prod.tfvars
gpushed config    # set project_id (and region/zone if you like)
gpushed up
```

`up` creates the infrastructure, waits for SSH, then runs the setup script
and streams its output. First boot takes about 10–15 minutes, mostly
downloading the driver and CUDA. When it finishes:

```bash
gpushed ssh
nvidia-smi
```

If `nvidia-smi` can't talk to the driver right after setup, `sudo reboot` once.

## Commands

| Command | What it does |
|---|---|
| `gpushed init` | Generate an SSH key pair and `config/prod.tfvars` from the example |
| `gpushed up` | Create the VM and provision it |
| `gpushed setup` | Re-run provisioning on an existing VM |
| `gpushed ssh` | SSH into the VM |
| `gpushed status` | Show the VM's Terraform outputs |
| `gpushed down` | Destroy the VM and everything created with it |
| `gpushed config` | Open `config/prod.tfvars` in `$EDITOR` |
| `gpushed version` | Show the installed version |
| `gpushed update` | Upgrade to the latest release |

Each SSH key gets its own Terraform workspace, so teammates with different
keys can each run their own box from the same checkout.

## Configuration

Settings live in `~/.gpushed/config/prod.tfvars` (or `config/prod.tfvars` in a checkout; gitignored). See
[`terraform.tfvars.example`](terraform.tfvars.example).

| Variable | Description | Default |
|---|---|---|
| `project_id` | GCP project ID | required |
| `region` | GCP region | required |
| `zone` | GCP zone; must offer your GPU | `us-west1-b` |
| `vpc_cidr_block` | CIDR for the box's VPC | required |
| `machine_type` | GCE machine type | `e2-medium` |
| `gpu_type` | Accelerator to attach (non-A2/A3 machines) | `nvidia-tesla-a100` |
| `gpu_count` | GPUs to attach; `0` for A2/A3, which have them built in | `1` |
| `admin_username` | SSH user (avoid `admin`, `root`, `ubuntu`) | `boxuser` |
| `admin_ssh_keys` | `[{ username, public_key }]` | required |
| `dns_zone_name` | Existing Cloud DNS zone, or `""` | `""` |
| `dns_domain` | Domain for that zone, with trailing dot | `""` |
| `vm_hostname` | Host label in the zone | `box` |

**Other GPUs.** For a cheaper box, attach a GPU to a general-purpose machine:

```hcl
machine_type = "n1-standard-8"
gpu_type     = "nvidia-tesla-t4"
gpu_count    = 1
```

Check which zones offer which GPUs:
<https://cloud.google.com/compute/docs/gpus/gpu-regions-zones>.

**DNS.** With `dns_zone_name = ""` the box is reachable by IP (and the
`vm_dns_name` output gives a `nip.io` name). With an existing Cloud DNS zone,
it gets `<vm_hostname>.<dns_domain>`.

**State.** Terraform state is local by default. To share it across a team,
uncomment the `gcs` backend in [`provider.tf`](provider.tf) and point it at a
bucket you own.

## How provisioning works

`main.tf` passes [`scripts/startup-wrapper.sh`](scripts/startup-wrapper.sh)
(which embeds [`scripts/setup.sh`](scripts/setup.sh)) as the VM's startup
script. Both the boot-time startup service and `gpushed up` run it; a lock
makes the second run wait and then exit, so they never fight over apt.

Setup makes apt use IPv4 only (GCE VMs have no IPv6 route) and gives it short
timeouts with retries, since Ubuntu's mirrors can stall from GCE.

Logs and markers on the VM:

```bash
sudo cat /var/log/setup-script.log       # full setup output
cat /var/log/provisioning-completed      # present once setup has finished
```

Don't run `apt` yourself until `provisioning-completed` exists; setup holds
the apt lock until then.

## Costs

GPU VMs are expensive: an `a2-highgpu-1g` runs roughly $3–4/hour on demand.
The VM bills while it exists, even when idle. Run `gpushed down` when you're
done.

## Security notes

- SSH (port 22) is open to `0.0.0.0/0`. Narrow `source_ranges` in `main.tf`
  if you have a fixed IP.
- Secure Boot is off so the NVIDIA kernel module loads; vTPM and integrity
  monitoring stay on.
- Never commit `box_ssh_key`, `config/*.tfvars` or `*.tfstate`; `.gitignore`
  already excludes them.

## License

[Apache-2.0](LICENSE)

## Releasing

Push a version tag and the [Release workflow](.github/workflows/release.yml)
builds `gpushed.tar.gz`, its `.sha256` and `install.sh`, smoke-tests the
installer, and publishes them as a GitHub release:

```bash
git tag v0.1.0 && git push origin v0.1.0
```
