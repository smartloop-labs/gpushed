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
# service account, and Workload Identity Federation so the provision workflow
# can act as that account without any stored key.

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
  display_name = "gpushed provisioner (GitHub Actions)"
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
  }
  attribute_condition = "assertion.repository == '${var.github_repo}' && assertion.ref == '${var.github_ref}'"
  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account_iam_member" "github" {
  service_account_id = google_service_account.provisioner.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repo}"
}

# ---------------------------------------------------------------- outputs (GitHub Actions variables)

output "GCP_PROJECT" {
  value = var.project_id
}


output "GCP_SERVICE_ACCOUNT" {
  value = google_service_account.provisioner.email
}

output "GCP_WORKLOAD_IDENTITY_PROVIDER" {
  value = google_iam_workload_identity_pool_provider.github.name
}
