terraform {
  required_version = ">= 1.6.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "6.21.0"
    }
  }

  # State lives in Cloudflare R2 (S3-compatible), one object per box. bucket,
  # key and endpoints are passed with -backend-config by provision.sh; the
  # credentials come from AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY.
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

provider "google" {
  project = var.project_id
  region  = var.region
}
