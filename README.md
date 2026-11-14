# gpushed

> **macOS only:** Macs with Apple silicon on macOS 26+, using Apple's native
> `container` runtime. Linux, Windows and Intel Macs aren't supported.

Your dedicated NVIDIA GPU, from your Mac. Sign in with your email, add credit, and
get an NVIDIA GPU box (Ubuntu 22.04, driver + CUDA) in a few minutes. There's no
cloud account, quota request or Terraform to set up. You pay per second from a
prepaid balance and delete the box when you're done.

Install. This also runs `gpushed init`, which sets up Apple's container runtime
and signs you in by email:

```bash
curl -fsSL gpushed.smartloop.ai/install.sh | bash
```

Then:

```bash
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

| Plan | GPU | Machine | Price / hour (US) |
|---|---|---|---|
| `t4` | 1x Tesla T4 16 GB | n1-standard-8 | $0.91 |
| `l4` (default) | 1x L4 24 GB | g2-standard-4 | $0.88 |
| `a100` | 1x A100 40 GB | a2-highgpu-1g | $4.44 |

Prices are GCP's on-demand cost of the machine, its 100 GB SSD and IP, plus
20%. A box is billed per second from when it's created until it's deleted. A
stopped box costs only its disk (about $0.03/hour).

**Regions.** A new box goes to the region nearest you (from Cloudflare's
estimate of where your request comes from): us-central1 (Iowa), us-east1
(South Carolina), us-west1 (Oregon), europe-west4 (Netherlands) or
asia-southeast1 (Singapore). If that region is out of GPUs it tries the next
nearest, and it's billed at the price of the region it lands in. Europe is
about 3-5% above the US and Singapore 9-23%; `gpushed plans` shows the prices
for your region, `gpushed plans --region asia-southeast1` for another, and
`gpushed up l4 --region europe-west4` picks the region yourself.

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
| `gpushed login` | Sign in with your smartloop account in the browser (`--email [address]`: with an emailed code instead) |
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
              at gpushed-api.smartloop.ai · smartloop accounts · balances
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

**Accounts.** gpushed users are smartloop accounts. `gpushed login` signs in
in the browser: the CLI starts a sign-in (`POST /auth/cli/start`) and opens
`app.smartloop.ai/gpushed/cli-login?code=XXXX-XXXX`; you sign in there if
needed and approve the code shown in the terminal (`POST /auth/cli/approve`,
with your smartloop session), and the CLI, polling `POST /auth/cli/poll` with
its secret device code, gets a long-lived gpushed token. Sign-ins expire after
10 minutes. `gpushed login --email` instead asks smartloop's API
(`/v1/auth/otp/request` and `/verify`) for an emailed code and trades the
smartloop access token for a gpushed token (`POST /auth/smartloop`, checked with
smartloop's `/v1/users/me`). The gpushed user id is the smartloop user id.

**Web app.** The smartloop web app can call the same API from the browser with
the user's smartloop access token (`Authorization: Bearer <token>`), from the
origins in `APP_ORIGINS`. Useful routes for a usage page:
`GET /me` (balance and box), `GET /usage?days=30`
(spend and top-ups per day), `GET /ledger?kind=topup` (recent
top-ups), `GET /plans`, and `POST /topup` (returns a
Stripe checkout URL; pass `return_url` on the web app to come back to it with
`?topup=done` or `?topup=cancelled`).

**Billing.** Money is stored in micro-dollars in D1. Every change is a ledger
row with a unique ref, so Stripe webhooks and metering runs are idempotent.
A box is billed from the moment Terraform reports it created, at the plan's
price while running and the disk price while stopped.

## Operating it

### One-time setup

1. **Cloudflare R2**: create two buckets:
   ```bash
   npx wrangler r2 bucket create gpushed-releases   # public, served at dl.gpushed.smartloop.ai
   npx wrangler r2 bucket create gpushed-state      # private, Terraform state
   npx wrangler r2 bucket domain add gpushed-releases --domain dl.gpushed.smartloop.ai --zone-id <zone>
   ```
   Create two R2 API tokens: one with write access to `gpushed-releases`
   (release workflow), one with read/write on `gpushed-state` (provision workflow).
   Optional: a lifecycle rule to expire old releases' images after 30 days.

2. **API** (Cloudflare Worker + D1):
   ```bash
   cd api && npm ci
   npx wrangler d1 create gpushed          # put the id in wrangler.toml
   npx wrangler d1 migrations apply gpushed --remote
   npx wrangler secret put STRIPE_SECRET_KEY
   npx wrangler secret put STRIPE_WEBHOOK_SECRET   # endpoint: https://gpushed-api.smartloop.ai/stripe/webhook,
                                                   # events: checkout.session.completed, checkout.session.async_payment_succeeded
   npx wrangler secret put RESEND_API_KEY          # low-balance emails
   npx wrangler secret put GITHUB_TOKEN            # fine-grained PAT: Actions read/write on this repo
   npx wrangler secret put PROVISIONER_SECRET      # random; same value as the GitHub secret below
   npx wrangler deploy
   ```
   The Worker is served at `gpushed-api.smartloop.ai`, a Worker custom domain
   (Cloudflare creates its DNS record and certificate on deploy), so the
   `smartloop.ai` zone must be in the same Cloudflare account.
   Pricing knobs (`PREMIUM_PCT`, `MIN_TOPUP_USD`, `LOW_BALANCE_USD`,
   `STOPPED_GRACE_HOURS`, and `REGIONS` to limit regions) are in
   [`api/wrangler.toml`](api/wrangler.toml). Regions are listed in
   [`api/src/regions.ts`](api/src/regions.ts) (and their subnets in
   `infra/bootstrap`); GCP list prices per plan and region are generated into
   `api/src/regions.generated.ts` by `node api/scripts/gcp-prices.mjs <project>`.

3. **GitHub**: create an environment named `production`, limited to `main`, with:

   | Kind | Name | Value |
   |---|---|---|
   | variable | `GCP_PROJECT`, `GCP_SERVICE_ACCOUNT`, `GCP_WORKLOAD_IDENTITY_PROVIDER` | set by step 4 |
   | variable | `GPUSHED_API` | `https://gpushed-api.smartloop.ai` |
   | variable | `GPUSHED_DL` | `https://dl.gpushed.smartloop.ai` |
   | variable | `R2_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` |
   | variable | `R2_STATE_BUCKET` / `R2_RELEASE_BUCKET` | `gpushed-state` / `gpushed-releases` |
   | variable | `CLOUDFLARE_ACCOUNT_ID` | your account ID |
   | secret | `PROVISIONER_SECRET` | same as the Worker's |
   | secret | `R2_STATE_ACCESS_KEY_ID`, `R2_STATE_SECRET_ACCESS_KEY` | state bucket token |
   | secret | `R2_RELEASE_ACCESS_KEY_ID`, `R2_RELEASE_SECRET_ACCESS_KEY` | release bucket token |
   | secret | `CLOUDFLARE_API_TOKEN` | Workers + D1 edit, for API deploys |
   | secret | `GCP_BOOTSTRAP_KEY` | for step 4 only; delete afterwards |
   | secret | `GH_ADMIN_TOKEN` | optional, for step 4: fine-grained PAT that can write this repo's environment variables |

   Limit the environment to the `main` branch and `v*` tags (the release
   workflow runs in it on tags).

   This repo is public, so anyone can read workflow logs. `provision.sh` keeps
   Terraform output out of the log and masks IPs, but running `provision.yml`
   from a private repo (set `GITHUB_REPO` in `wrangler.toml` and
   `github_repo` in the bootstrap) keeps box metadata fully private.

4. **GCP** (in our project; needs GPU quota in each region): run
   **Actions > Bootstrap GCP** with `plan`, check it, then run it with `apply`.
   It runs [`infra/bootstrap`](infra/bootstrap) with Terraform state in
   `gpushed-state/bootstrap/terraform.tfstate`, and stores its outputs as
   `production` variables (with `GH_ADMIN_TOKEN`; otherwise copy them from
   the run summary).

   `GCP_BOOTSTRAP_KEY` is a JSON key for a service account with
   `roles/owner` on the project:
   ```bash
   gcloud iam service-accounts create gpushed-bootstrap --project <project>
   gcloud projects add-iam-policy-binding <project> \
     --member serviceAccount:gpushed-bootstrap@<project>.iam.gserviceaccount.com --role roles/owner
   gcloud iam service-accounts keys create key.json \
     --iam-account gpushed-bootstrap@<project>.iam.gserviceaccount.com
   gh secret set GCP_BOOTSTRAP_KEY --env production < key.json && rm key.json
   ```
   Afterwards delete the key (or the whole account); boxes are provisioned
   through Workload Identity and never use it. Re-run the workflow (with a new
   key) only to change the bootstrap, e.g. after renaming the repo. If your
   organization blocks service account keys
   (`iam.disableServiceAccountKeyCreation`), run `infra/bootstrap` by hand
   instead; the commands are at the top of its `main.tf`.

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
  ./gpushed login --email you@example.com
```

`curl localhost:8787/__scheduled` runs the metering cron once.

## License

[Apache-2.0](LICENSE)
