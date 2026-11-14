# gpushed

> **macOS only:** Macs with Apple silicon on macOS 26+, using Apple's native
> `container` runtime. Linux, Windows and Intel Macs aren't supported.

GPU boxes on demand, from your Mac. Sign in with your email, add credit, and
get an NVIDIA GPU box (Ubuntu 22.04, driver + CUDA) in a few minutes. There's no
cloud account, quota request or Terraform to set up. You pay per second from a
prepaid balance and delete the box when you're done.

```bash
curl -fsSL gpushed.smartloop.ai/install.sh | bash   # installs, then runs gpushed init

gpushed init         # installs Apple's container runtime, signs you in by email
gpushed topup        # add credit with Stripe (minimum $10)
gpushed up           # create your box (default: 1x L4 24 GB)
gpushed ssh          # connect; try nvidia-smi
gpushed down         # delete it
```

## Requirements

- A Mac with **Apple silicon** on **macOS 26** or later
- Apple's native container runtime, which `gpushed init` sets up for you: it
  downloads the latest signed installer from
  <https://github.com/apple/container/releases>, checks it's signed by Apple
  (Developer ID "Apple Inc. - Containerization") and notarized, installs it
  (asks for your password once), and starts it

The gpushed client runs inside an Apple container, so nothing else needs to be
installed. `init` also downloads the client image from our release bucket.

## Plans and pricing

```bash
gpushed plans
```

| Plan | GPU | Machine | Price / hour |
|---|---|---|---|
| `t4` | 1x Tesla T4 16 GB | n1-standard-8 | $0.91 |
| `l4` (default) | 1x L4 24 GB | g2-standard-4 | $0.88 |
| `a100` | 1x A100 40 GB | a2-highgpu-1g | $4.44 |
| `a100-80` | 1x A100 80 GB | a2-ultragpu-1g | $6.12 |

Prices are GCP's on-demand cost of the machine, its 100 GB SSD and IP, plus
20%. A box is billed per second from when it's created until it's deleted. A
stopped box costs only its disk (about $0.03/hour).

**Balance.** Credit is prepaid: the minimum top-up is $10, and you can top up
any amount above that at any time with `gpushed topup 25`. To create or start a
box you need at least one hour of its price in your balance.

**Running out.** When your balance falls below $2 you get an email. When it's
nearly used up, your box is **stopped** (its disk is kept) and you get another
email. Top up and run `gpushed start` to carry on. A box that stays stopped
with no credit for 24 hours is deleted.

## Commands

| Command | What it does |
|---|---|
| `gpushed init` | Install Apple's container runtime, fetch the client, sign in |
| `gpushed login [email]` | Sign in with your smartloop account (emailed code); opens smartloop sign-up if you don't have one |
| `gpushed logout` | Sign out on this Mac |
| `gpushed balance` | Show your balance |
| `gpushed topup [usd]` | Add credit (opens Stripe Checkout; minimum $10) |
| `gpushed history` | Recent charges and top-ups |
| `gpushed plans` | GPUs available and their prices |
| `gpushed up [plan]` | Create your box and watch it install the driver + CUDA |
| `gpushed status` | Show your box |
| `gpushed ssh [cmd]` | SSH into the box, or run a command on it |
| `gpushed stop` / `start` | Pause and resume (disk kept) |
| `gpushed down` | Delete the box and its disk |
| `gpushed update` | Upgrade to the latest release |
| `gpushed uninstall` | Remove gpushed from this Mac |

Your API token and the box's SSH key are in `~/.gpushed/state`. To SSH from
outside gpushed: `ssh -i ~/.gpushed/state/box_ssh_key boxuser@<ip>` (the IP is
in `gpushed status`; it changes after a stop/start).

## What you get

- An Ubuntu 22.04 VM with the NVIDIA driver 535 (server) and CUDA Toolkit 12.6;
  nothing else, so the box is yours to set up
- A 100 GB SSD and a public IP; only SSH (port 22) is open
- First boot takes 10–15 minutes, mostly installing the driver and CUDA.
  `gpushed up` streams the progress. If `nvidia-smi` can't talk to the driver
  right after setup, `sudo reboot` once.

Boxes run in smartloop's GCP project. They have no Google credentials and
can't reach each other.

---

## How it works

```
 Mac ─ gpushed ─► Apple container (gpushed-cli image, from R2; no cloud keys)
                        │ API token (per user)
                        ▼
              gpushed API  (Cloudflare Worker + D1)
              at api.smartloop.ai/v1/gpushed · smartloop accounts · balances
              Stripe · metering cron (every 5 min)
                        │ workflow_dispatch (box ID only)
                        ▼
              GitHub Actions: provision.yml
              pulls the provisioner image (Terraform + gcloud) from R2 and
              injects GCP credentials (Workload Identity) + R2 keys at run time
                        │ terraform (state in R2)
                        ▼
              GCE GPU VM in smartloop's GCP project
```

| Path | What it is |
|---|---|
| [`gpushed`](gpushed), [`install.sh`](install.sh) | Mac command and installer |
| [`client/`](client) | Client image (`Containerfile`) and the CLI that runs in it |
| [`api/`](api) | Cloudflare Worker: smartloop sign-in, billing, Stripe webhook, metering, dispatch |
| [`provisioner/`](provisioner) | Provisioner image, entrypoint and the box's Terraform |
| [`infra/bootstrap/`](infra/bootstrap) | One-time GCP setup: network, service account, Workload Identity |
| [`.github/workflows/`](.github/workflows) | `provision.yml`, `release.yml`, `ci.yml` (tests + API deploy) |

**Why the keys aren't in the client image.** The client runs on users' Macs, so
anything inside it can be read by them. A cloud key there would let anyone
create VMs in our project without paying. Instead, the client holds only a
per-user API token; the API checks the balance before it asks GitHub Actions
(which has the cloud access) to provision anything, and metering runs on the
server.

**Accounts.** gpushed users are smartloop accounts. `gpushed login` asks
smartloop's API (`/v1/auth/otp/request` and `/verify`) for an emailed sign-in
code; if the email has no account, it opens <https://app.smartloop.ai/signup>.
The CLI then trades the smartloop access token for a long-lived gpushed token
(`POST /auth/smartloop`, which checks it with smartloop's `/v1/users/me`). The
gpushed user id is the smartloop user id.

**Web app.** The smartloop web app can call the same API from the browser with
the user's smartloop access token (`Authorization: Bearer <token>`), from the
origins in `APP_ORIGINS`. Useful routes for a usage page:
`GET /v1/gpushed/me` (balance and box), `GET /v1/gpushed/ledger` (recent
charges and top-ups), `GET /v1/gpushed/plans`, and `POST /v1/gpushed/topup`
(returns a Stripe checkout URL).

**Billing.** Money is stored in micro-dollars in D1. Every change is a ledger
row with a unique ref, so Stripe webhooks and metering runs are idempotent.
A box is billed from the moment Terraform reports it created, at the plan's
price while running and the disk price while stopped.

## Operating it

### One-time setup

1. **GCP** (in our project; needs GPU quota in the region):
   ```bash
   cd infra/bootstrap
   terraform init && terraform apply -var project_id=<project>
   ```
   Note the outputs for step 4.

2. **Cloudflare R2**: create two buckets:
   ```bash
   npx wrangler r2 bucket create gpushed-releases   # public, served at dl.gpushed.smartloop.ai
   npx wrangler r2 bucket create gpushed-state      # private, Terraform state
   npx wrangler r2 bucket domain add gpushed-releases --domain dl.gpushed.smartloop.ai --zone-id <zone>
   ```
   Create two R2 API tokens: one with write access to `gpushed-releases`
   (release workflow), one with read/write on `gpushed-state` (provision workflow).
   Optional: a lifecycle rule to expire old releases' images after 30 days.

3. **API** (Cloudflare Worker + D1):
   ```bash
   cd api && npm ci
   npx wrangler d1 create gpushed          # put the id in wrangler.toml
   npx wrangler d1 migrations apply gpushed --remote
   npx wrangler secret put STRIPE_SECRET_KEY
   npx wrangler secret put STRIPE_WEBHOOK_SECRET   # endpoint: https://api.smartloop.ai/v1/gpushed/stripe/webhook,
                                                   # events: checkout.session.completed, checkout.session.async_payment_succeeded
   npx wrangler secret put RESEND_API_KEY          # low-balance emails
   npx wrangler secret put GITHUB_TOKEN            # fine-grained PAT: Actions read/write on this repo
   npx wrangler secret put PROVISIONER_SECRET      # random; same value as the GitHub secret below
   npx wrangler deploy
   ```
   The Worker is routed at `api.smartloop.ai/v1/gpushed/*`, so the
   `smartloop.ai` zone must be in the same Cloudflare account and the `api`
   record proxied (orange cloud); the rest of `api.smartloop.ai` keeps going to
   smartloop's API.
   Pricing knobs (`PREMIUM_PCT`, `MIN_TOPUP_USD`, `LOW_BALANCE_USD`,
   `STOPPED_GRACE_HOURS`, `REGION`) are in [`api/wrangler.toml`](api/wrangler.toml);
   GCP list prices per plan are in [`api/src/pricing.ts`](api/src/pricing.ts).

4. **GitHub**: create an environment named `production`, limited to `main`, with:

   | Kind | Name | Value |
   |---|---|---|
   | variable | `GCP_PROJECT`, `GCP_SUBNETWORK`, `GCP_SERVICE_ACCOUNT`, `GCP_WORKLOAD_IDENTITY_PROVIDER` | bootstrap outputs |
   | variable | `GPUSHED_API` | `https://api.smartloop.ai/v1/gpushed` |
   | variable | `GPUSHED_DL` | `https://dl.gpushed.smartloop.ai` |
   | variable | `R2_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` |
   | variable | `R2_STATE_BUCKET` / `R2_RELEASE_BUCKET` | `gpushed-state` / `gpushed-releases` |
   | variable | `CLOUDFLARE_ACCOUNT_ID` | your account ID |
   | secret | `PROVISIONER_SECRET` | same as the Worker's |
   | secret | `R2_STATE_ACCESS_KEY_ID`, `R2_STATE_SECRET_ACCESS_KEY` | state bucket token |
   | secret | `R2_RELEASE_ACCESS_KEY_ID`, `R2_RELEASE_SECRET_ACCESS_KEY` | release bucket token |
   | secret | `CLOUDFLARE_API_TOKEN` | Workers + D1 edit, for API deploys |

   The release workflow's secrets and `R2_*` variables must be available to it
   too (repository level, or move its job into the environment).

   This repo is public, so anyone can read workflow logs. `provision.sh` keeps
   Terraform output out of the log and masks IPs, but running `provision.yml`
   from a private repo (set `GITHUB_REPO` in `wrangler.toml` and
   `github_repo` in the bootstrap) keeps box metadata fully private.

### Releasing

```bash
git tag v0.2.0 && git push origin v0.2.0
```

The release workflow builds the CLI package, the client image (linux/arm64,
OCI archive for `container image load`) and the provisioner image
(linux/amd64), uploads them to R2 under `v0.2.0/`, then moves `latest`.

### Local development

```bash
cd api && npm ci
npx wrangler d1 migrations apply gpushed --local --env dev
npx wrangler dev --env dev --test-scheduled --ip 0.0.0.0   # emails and dispatches are logged, not sent
# Sign-in goes to SMARTLOOP_API in wrangler.toml [env.dev] (a local smartloop
# API on :8788, or set it to https://api.smartloop.ai to use real accounts).
npm test

# In another terminal, from a checkout (builds the client image locally). Use
# the Mac's address as seen from containers (the vmnet gateway, usually 192.168.64.1):
GPUSHED_API=http://192.168.64.1:8787 GPUSHED_SMARTLOOP_API=http://192.168.64.1:8788 \
  ./gpushed login you@example.com
```

`curl localhost:8787/__scheduled` runs the metering cron once.

## License

[Apache-2.0](LICENSE)
