variable "project_id" {
  description = "GCP project the boxes run in (ours)"
  type        = string
}

variable "region" {
  type = string
}

variable "zone" {
  type = string
}

variable "network" {
  description = "Shared VPC created by infra/bootstrap"
  type        = string
  default     = "gpushed"
}

variable "subnetwork" {
  description = "Subnet of var.network in var.region"
  type        = string
}

variable "box_id" {
  description = "Box ID from the API; names every resource"
  type        = string
  validation {
    condition     = can(regex("^b[a-z0-9]{11}$", var.box_id))
    error_message = "box_id must look like bxxxxxxxxxxx."
  }
}

variable "image" {
  description = "Boot image: the newest gpushed-cuda image (driver, CUDA and dev tools baked in, see image/build.sh), or stock Ubuntu, which installs everything on first boot"
  type        = string
  default     = "ubuntu-os-cloud/ubuntu-2204-lts"
}

variable "machine_type" {
  type = string
}

variable "gpu_type" {
  description = "Accelerator to attach; empty when the machine type includes it (A2, G2)"
  type        = string
  default     = ""
}

variable "gpu_count" {
  type    = number
  default = 0
}

variable "ssh_user" {
  type    = string
  default = "boxuser"
}

variable "ssh_public_key" {
  description = "The user's public key (\"type base64\", no comment)"
  type        = string
}

variable "desired_status" {
  description = "RUNNING or TERMINATED (stopped)"
  type        = string
  default     = "RUNNING"
}
