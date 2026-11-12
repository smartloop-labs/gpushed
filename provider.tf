# Copyright (c) HashiCorp, Inc.
# SPDX-License-Identifier: MPL-2.0

terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "6.21.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
  }

  required_version = ">= 1.0.1"

  # State is local by default. To share it (and get locking) across a team,
  # store it in a GCS bucket you own instead:
  #
  # backend "gcs" {
  #   bucket = "your-terraform-state-bucket"
  #   prefix = "gpushed"
  # }
}

provider "google" {
  project = var.project_id
  region  = var.region
}