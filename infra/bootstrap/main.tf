# One-time setup of smartloop's GCP project for gpushed. Run by an admin:
#
#   gcloud auth application-default login
#   terraform init && terraform apply -var project_id=<our-project>
#
# Then copy the outputs into the repo's GitHub Actions variables (see README).
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
}

variable "project_id" {
  type = string
}

variable "region" {
  type    = string
  default = "us-central1"
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
  region  = var.region
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

resource "google_compute_subnetwork" "boxes" {
  name          = "gpushed-${var.region}"
  region        = var.region
  network       = google_compute_network.gpushed.id
  ip_cidr_range = "10.20.0.0/16"
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
# subnet; SSH from the internet doesn't match this rule and stays allowed.
resource "google_compute_firewall" "deny_internal" {
  name          = "gpushed-deny-internal"
  network       = google_compute_network.gpushed.name
  priority      = 900
  direction     = "INGRESS"
  source_ranges = [google_compute_subnetwork.boxes.ip_cidr_range]
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

output "GCP_SUBNETWORK" {
  value = google_compute_subnetwork.boxes.name
}

output "GCP_SERVICE_ACCOUNT" {
  value = google_service_account.provisioner.email
}

output "GCP_WORKLOAD_IDENTITY_PROVIDER" {
  value = google_iam_workload_identity_pool_provider.github.name
}
