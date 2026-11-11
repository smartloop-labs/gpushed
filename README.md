# my-gpu-box

Spin up your own NVIDIA GPU box on Google Cloud with one command, with no
waitlist and no day-long queue for capacity. You get a clean Ubuntu 22.04 VM with
the NVIDIA driver and CUDA installed, an SSH key, and a static IP. Tear it
down when you're done so you only pay for the hours you use.

```bash
./box.sh up      # create the VM and install the NVIDIA driver + CUDA
./box.sh ssh     # connect
nvidia-smi       # on the box
./box.sh down    # destroy everything
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

## Quick start

```bash
git clone https://github.com/smartlooplabs/my-gpu-box.git
cd my-gpu-box

./box.sh init                 # generates ./box_ssh_key and config/prod.tfvars
$EDITOR config/prod.tfvars    # set project_id (and region/zone if you like)
./box.sh up
```

`up` creates the infrastructure, waits for SSH, then runs the setup script
and streams its output. First boot takes about 10–15 minutes, mostly
downloading the driver and CUDA. When it finishes:

```bash
./box.sh ssh
nvidia-smi
```

If `nvidia-smi` can't talk to the driver right after setup, `sudo reboot` once.

## Commands

| Command | What it does |
|---|---|
| `./box.sh init` | Generate an SSH key pair and `config/prod.tfvars` from the example |
| `./box.sh up` | Create the VM and provision it |
| `./box.sh setup` | Re-run provisioning on an existing VM |
| `./box.sh ssh` | SSH into the VM |
| `./box.sh status` | Show the VM's Terraform outputs |
| `./box.sh down` | Destroy the VM and everything created with it |

Each SSH key gets its own Terraform workspace, so teammates with different
keys can each run their own box from the same checkout.

## Configuration

Settings live in `config/prod.tfvars` (gitignored). See
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
script. Both the boot-time startup service and `box.sh up` run it; a lock
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
The VM bills while it exists, even when idle. Run `./box.sh down` when you're
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
