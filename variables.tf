variable "project_id" {
  description = "project id"
}

variable "region" {
  description = "region"
}

variable "zone" {
  description = "Zone where VM will be created"
  default     = "us-west1-b"
}

variable "dns_zone_name" {
  description = "Cloud DNS zone name (e.g., 'my-zone')"
  type        = string
  default     = ""
}

variable "dns_domain" {
  description = "DNS domain name (e.g., 'example.com.'). Note the trailing dot."
  type        = string
  default     = ""
}

variable "vm_hostname" {
  description = "VM hostname (e.g., 'box' will create box.example.com)"
  type        = string
  default     = "box"
}
variable "vpc_cidr_block" {
  description = "CIDR block for the virtual network"
}


variable "machine_type" {
  description = "Machine type for the GCP VM"
  default     = "e2-medium"
}

variable "gpu_type" {
  description = "GPU type (e.g., nvidia-tesla-a100, nvidia-tesla-v100, nvidia-tesla-t4)"
  default     = "nvidia-tesla-a100"
}

variable "gpu_count" {
  description = "Number of GPUs to attach"
  default     = 1
}

variable "admin_username" {
  description = "Admin username for the VM (avoid: admin, root, ubuntu)"
  default     = "boxuser"
}

variable "admin_ssh_keys" {
  description = "List of admin SSH public keys"
  type = list(object({
    username   = string
    public_key = string
  }))
}
