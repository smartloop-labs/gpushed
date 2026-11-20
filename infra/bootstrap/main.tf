# One-time setup of smartloop's GCP project for gpushed. Normally run from
# GitHub: Actions > Bootstrap GCP (.github/workflows/bootstrap.yml), which
# also stores the outputs as GitHub Actions variables. To run it by hand:
#
#   gcloud auth application-default login
#   export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...   # R2 state token
#   terraform init -backend-config="bucket=gpushed-state" \
#     -backend-config="key=bootstrap/terraform.tfstate" \
#     -backend-config='endpoints={s3="https://<account>.r2.cloudflarestorage.com"}'
#   terraform apply -var project_id=<our-project>
#
# Creates: the shared VPC boxes live in, an SSH firewall rule, the provisioner
# and image-builder service accounts, the gpushed-provisioner Cloud Run job
# (with its image registry and secrets) and the dispatcher account the API
# starts it with, and Workload Identity Federation so the workflows (image
# builds, releases, and provision.yml while it's still used) act as their
# accounts without any stored key.
#
# By hand, also pass the job's settings and secrets (bootstrap.yml takes them
# from the `production` environment):
#   export TF_VAR_gpushed_api=https://api.gpushed.dev TF_VAR_r2_endpoint=... \
#     TF_VAR_r2_state_bucket=gpushed-state TF_VAR_provisioner_secret=... \
#     TF_VAR_r2_state_access_key_id=... TF_VAR_r2_state_secret_access_key=...

terraform {
  required_version = ">= 1.6.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "6.21.0"
    }
  }

  # State lives in Cloudflare R2 (S3-compatible); bucket, key and endpoint
  # are passed with -backend-config.
  backend "s3" {
    region                      = "auto"
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
    use_path_style              = true
  }
}

variable "project_id" {
  type = string
}

# Regions boxes run in, each with its subnet's range. Keep in step with
# REGIONS in api/src/regions.ts. Add new regions with new ranges; changing a
# region's range recreates its subnet.
variable "regions" {
  type = map(string)
  default = {
    "us-central1"     = "10.20.0.0/16"
    "us-east1"        = "10.21.0.0/16"
    "us-west1"        = "10.22.0.0/16"
    "europe-west4"    = "10.23.0.0/16"
    "asia-southeast1" = "10.24.0.0/16"
    "asia-east1"      = "10.25.0.0/16"
  }
}

variable "github_repo" {
  description = "owner/name of the repo whose provision workflow may provision boxes"
  type        = string
  default     = "smartloop-labs/gpushed"
}

variable "github_ref" {
  description = "Only workflow runs from this ref may act as the provisioner"
  type        = string
  default     = "refs/heads/main"
}

# ---- the provisioner Cloud Run job

variable "run_region" {
  description = "Region of the provisioner Cloud Run job and its image registry"
  type        = string
  default     = "us-central1"
}

variable "gpushed_api" {
  description = "The gpushed API the provisioner reports to"
  type        = string
  default     = "https://api.gpushed.dev"
}

variable "r2_endpoint" {
  description = "https://<account-id>.r2.cloudflarestorage.com (Terraform state of boxes)"
  type        = string
}

variable "r2_state_bucket" {
  type    = string
  default = "gpushed-state"
}

# Copied into Secret Manager for the job.
variable "provisioner_secret" {
  description = "The API's PROVISIONER_SECRET"
  type        = string
  sensitive   = true
}

variable "r2_state_access_key_id" {
  type      = string
  sensitive = true
}

variable "r2_state_secret_access_key" {
  type      = string
  sensitive = true
}

provider "google" {
  project = var.project_id
}

data "google_project" "this" {}

resource "google_project_service" "apis" {
  for_each = toset([
    "compute.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "sts.googleapis.com",
    "run.googleapis.com",
    "artifactregistry.googleapis.com",
    "secretmanager.googleapis.com",
  ])
  service            = each.value
  disable_on_destroy = false
}

# ---------------------------------------------------------------- network

resource "google_compute_network" "gpushed" {
  name                    = "gpushed"
  auto_create_subnetworks = false
  depends_on              = [google_project_service.apis]
}

# One subnet per region, named gpushed-<region> (provision.sh relies on it).
resource "google_compute_subnetwork" "boxes" {
  for_each      = var.regions
  name          = "gpushed-${each.key}"
  region        = each.key
  network       = google_compute_network.gpushed.id
  ip_cidr_range = each.value
}

resource "google_compute_firewall" "ssh" {
  name          = "gpushed-allow-ssh"
  network       = google_compute_network.gpushed.name
  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["gpushed-box"]
  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}

# Boxes belong to different users: don't let them reach each other inside the
# VPC. Priority 900 beats the SSH rule's default 1000 for sources inside the
# subnets; SSH from the internet doesn't match this rule and stays allowed.
resource "google_compute_firewall" "deny_internal" {
  name          = "gpushed-deny-internal"
  network       = google_compute_network.gpushed.name
  priority      = 900
  direction     = "INGRESS"
  source_ranges = values(var.regions)
  target_tags   = ["gpushed-box"]
  deny {
    protocol = "all"
  }
}

# ---------------------------------------------------------------- provisioner identity

resource "google_service_account" "provisioner" {
  account_id   = "gpushed-provisioner"
  display_name = "gpushed provisioner (Cloud Run job)"
}

# Create/stop/delete instances and read zones, machine and accelerator types.
resource "google_project_iam_member" "provisioner" {
  for_each = toset(["roles/compute.instanceAdmin.v1", "roles/compute.viewer"])
  project  = var.project_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.provisioner.email}"
}

resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "gpushed-github"
  display_name              = "gpushed GitHub Actions"
  depends_on                = [google_project_service.apis]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub OIDC"
  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
    "attribute.ref_type"   = "assertion.ref_type"
  }
  # Runs from main (ref_type "branch") and from release tags v* ("tag") only;
  # each service account below trusts one of the two.
  attribute_condition = "assertion.repository == '${var.github_repo}' && (assertion.ref == '${var.github_ref}' || (assertion.ref_type == 'tag' && assertion.ref.startsWith('refs/tags/v')))"
  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

locals {
  github_main = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.ref_type/branch"
  github_tags = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.ref_type/tag"
}

# provision.yml, while the API still uses it (PROVISIONER = "github"). Remove
# with the workflow once boxes are provisioned on Cloud Run.
resource "google_service_account_iam_member" "github" {
  service_account_id = google_service_account.provisioner.name
  role               = "roles/iam.workloadIdentityUser"
  member             = local.github_main
}

# ---------------------------------------------------------------- image builder identity

# image.yml (image/build.sh): runs a throwaway builder VM and saves its disk
# as a gpushed-cuda image. Separate from the provisioner, which only needs to
# read images, so a box workflow can never replace the image.
resource "google_service_account" "image_builder" {
  account_id   = "gpushed-image-builder"
  display_name = "gpushed image builder (GitHub Actions)"
}

resource "google_project_iam_member" "image_builder" {
  for_each = toset(["roles/compute.instanceAdmin.v1", "roles/compute.storageAdmin"])
  project  = var.project_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.image_builder.email}"
}

resource "google_service_account_iam_member" "github_image_builder" {
  service_account_id = google_service_account.image_builder.name
  role               = "roles/iam.workloadIdentityUser"
  member             = local.github_main
}

# ---------------------------------------------------------------- provisioner Cloud Run job

# The provisioner image, pushed by release.yml on each v* tag.
resource "google_artifact_registry_repository" "gpushed" {
  location      = var.run_region
  repository_id = "gpushed"
  format        = "DOCKER"
  description   = "gpushed provisioner image"
  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 10
    }
  }
  cleanup_policies {
    id     = "delete-old"
    action = "DELETE"
    condition {
      older_than = "2592000s" # 30 days, beyond the 10 kept
    }
  }
  depends_on = [google_project_service.apis]
}

locals {
  job_secrets = {
    PROVISIONER_SECRET    = var.provisioner_secret
    AWS_ACCESS_KEY_ID     = var.r2_state_access_key_id
    AWS_SECRET_ACCESS_KEY = var.r2_state_secret_access_key
  }
}

resource "google_secret_manager_secret" "job" {
  for_each  = toset(keys(local.job_secrets))
  secret_id = "gpushed-${lower(replace(each.key, "_", "-"))}"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "job" {
  for_each    = google_secret_manager_secret.job
  secret      = each.value.id
  secret_data = local.job_secrets[each.key]
}

resource "google_secret_manager_secret_iam_member" "provisioner" {
  for_each  = google_secret_manager_secret.job
  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.provisioner.email}"
}

# One execution per dispatch (the API starts it with no overrides); it claims
# queued runs from the API (provisioner/worker.sh). Runs as the provisioner
# account, so GCP credentials come from the metadata server: no key anywhere.
resource "google_cloud_run_v2_job" "provisioner" {
  name     = "gpushed-provisioner"
  location = var.run_region

  template {
    task_count  = 1
    parallelism = 1
    template {
      service_account = google_service_account.provisioner.email
      timeout         = "1800s"
      max_retries     = 0
      containers {
        # Set by release.yml (gcloud run jobs update --image); this public
        # sample only stands in until the first release.
        image   = "us-docker.pkg.dev/cloudrun/container/job:latest"
        command = ["/usr/local/bin/provision-worker"]
        resources {
          limits = {
            cpu    = "1"
            memory = "1Gi"
          }
        }
        env {
          name  = "GPUSHED_API"
          value = var.gpushed_api
        }
        env {
          name  = "GCP_PROJECT"
          value = var.project_id
        }
        env {
          name  = "R2_ENDPOINT"
          value = var.r2_endpoint
        }
        env {
          name  = "R2_STATE_BUCKET"
          value = var.r2_state_bucket
        }
        dynamic "env" {
          for_each = google_secret_manager_secret.job
          content {
            name = env.key
            value_source {
              secret_key_ref {
                secret  = env.value.secret_id
                version = "latest"
              }
            }
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].template[0].containers[0].image,
      client,
      client_version,
    ]
  }

  depends_on = [google_secret_manager_secret_version.job, google_secret_manager_secret_iam_member.provisioner]
}

# The API (Cloudflare Worker) starts executions with this account's JSON key
# (Worker secret GCP_DISPATCH_KEY). run.invoker on this job is all it has: it
# can't pass overrides, and an execution only does what the API queued.
resource "google_service_account" "dispatcher" {
  account_id   = "gpushed-dispatcher"
  display_name = "gpushed API: starts the provisioner job"
}

resource "google_cloud_run_v2_job_iam_member" "dispatcher" {
  name     = google_cloud_run_v2_job.provisioner.name
  location = google_cloud_run_v2_job.provisioner.location
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.dispatcher.email}"
}

# release.yml (v* tags): pushes the provisioner image and points the job at it.
resource "google_service_account" "releaser" {
  account_id   = "gpushed-releaser"
  display_name = "gpushed release (GitHub Actions)"
}

resource "google_artifact_registry_repository_iam_member" "releaser" {
  location   = google_artifact_registry_repository.gpushed.location
  repository = google_artifact_registry_repository.gpushed.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.releaser.email}"
}

resource "google_cloud_run_v2_job_iam_member" "releaser" {
  name     = google_cloud_run_v2_job.provisioner.name
  location = google_cloud_run_v2_job.provisioner.location
  role     = "roles/run.developer"
  member   = "serviceAccount:${google_service_account.releaser.email}"
}

# Updating a job that runs as the provisioner requires acting as it.
resource "google_service_account_iam_member" "releaser_acts_as_provisioner" {
  service_account_id = google_service_account.provisioner.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.releaser.email}"
}

resource "google_service_account_iam_member" "github_releaser" {
  service_account_id = google_service_account.releaser.name
  role               = "roles/iam.workloadIdentityUser"
  member             = local.github_tags
}

# ---------------------------------------------------------------- outputs (GitHub Actions variables)

output "GCP_PROJECT" {
  value = var.project_id
}


output "GCP_SERVICE_ACCOUNT" {
  value = google_service_account.provisioner.email
}

output "GCP_IMAGE_SERVICE_ACCOUNT" {
  value = google_service_account.image_builder.email
}

output "GCP_WORKLOAD_IDENTITY_PROVIDER" {
  value = google_iam_workload_identity_pool_provider.github.name
}

output "GCP_RELEASE_SERVICE_ACCOUNT" {
  value = google_service_account.releaser.email
}

# Where release.yml pushes the provisioner image.
output "GCP_PROVISIONER_IMAGE" {
  value = "${var.run_region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.gpushed.repository_id}/gpushed-provisioner"
}

# The API's CLOUD_RUN_JOB (wrangler.toml).
output "CLOUD_RUN_JOB" {
  value = google_cloud_run_v2_job.provisioner.id
}

output "GCP_DISPATCHER_SERVICE_ACCOUNT" {
  value = google_service_account.dispatcher.email
}
