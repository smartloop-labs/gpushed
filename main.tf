# Generate a random pet name for resources
resource "random_pet" "resource_name" {
  length    = 2
  separator = "-"
}

# VPC Network
resource "google_compute_network" "box_network" {
  name                    = "${random_pet.resource_name.id}-network"
  auto_create_subnetworks = false
}

# Subnet
resource "google_compute_subnetwork" "box_subnet" {
  name          = "${random_pet.resource_name.id}-subnet"
  ip_cidr_range = var.vpc_cidr_block
  region        = var.region
  network       = google_compute_network.box_network.id
}

# Firewall rule for SSH
resource "google_compute_firewall" "box_ssh" {
  name    = "${random_pet.resource_name.id}-ssh"
  network = google_compute_network.box_network.name

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }

  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["${random_pet.resource_name.id}-vm"]
}

# Reserve a static external IP
resource "google_compute_address" "box_ip" {
  name         = "${random_pet.resource_name.id}-ip"
  address_type = "EXTERNAL"
  region       = var.region
}

# Use existing Cloud DNS Zone (optional - only if dns_zone_name is provided)
data "google_dns_managed_zone" "box_zone" {
  count   = var.dns_zone_name != "" ? 1 : 0
  name    = var.dns_zone_name
  project = var.project_id
}

# DNS A record for the VM
resource "google_dns_record_set" "box_a_record" {
  count        = var.dns_zone_name != "" ? 1 : 0
  name         = "${var.vm_hostname}.${var.dns_domain}"
  managed_zone = data.google_dns_managed_zone.box_zone[0].name
  type         = "A"
  ttl          = 300
  rrdatas      = [google_compute_address.box_ip.address]
}

# Compute instance
resource "google_compute_instance" "box" {
  name         = random_pet.resource_name.id
  machine_type = var.machine_type
  zone         = var.zone

  boot_disk {
    initialize_params {
      image = "ubuntu-os-cloud/ubuntu-2204-lts"
      size  = 100
      type  = "pd-ssd"
    }
  }

  # GPU configuration (only for non-A2 instances, A2 has GPUs built-in)
  dynamic "guest_accelerator" {
    for_each = var.gpu_count > 0 ? [1] : []
    content {
      type  = var.gpu_type
      count = var.gpu_count
    }
  }

  # GPU instances require specific scheduling options
  scheduling {
    on_host_maintenance = "TERMINATE"
    automatic_restart   = true
  }

  # Disable secure boot for compatibility
  shielded_instance_config {
    enable_secure_boot          = false
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  network_interface {
    network    = google_compute_network.box_network.id
    subnetwork = google_compute_subnetwork.box_subnet.id

    access_config {
      nat_ip = google_compute_address.box_ip.address
    }
  }

  metadata = {
    ssh-keys = join("\n", [for key in var.admin_ssh_keys : "${key.username}:${file(key.public_key)}"])
  }

  tags = ["${random_pet.resource_name.id}-vm"]
  
  # Startup script that runs automatically on boot AND can be triggered manually
  metadata_startup_script = templatefile("${path.module}/scripts/startup-wrapper.sh", {
    setup_script = templatefile("${path.module}/scripts/setup.sh", {})
  })
}

# Output the generated resource name
output "resource_name" {
  value       = random_pet.resource_name.id
  description = "Generated resource name used for all resources"
}

# Output the external IP
output "vm_public_ip" {
  value       = google_compute_address.box_ip.address
  description = "Public IP address of the VM"
}

# Output the DNS name
output "vm_dns_name" {
  value       = var.dns_zone_name != "" ? "${var.vm_hostname}.${trimsuffix(var.dns_domain, ".")}" : "${var.vm_hostname}.${var.region}.${google_compute_address.box_ip.address}.nip.io"
  description = "DNS name for the VM"
}

# Output DNS nameservers (if Cloud DNS is used)
output "dns_nameservers" {
  value       = var.dns_zone_name != "" ? data.google_dns_managed_zone.box_zone[0].name_servers : []
  description = "DNS nameservers (configure these in your domain registrar)"
}

# Output SSH command
output "ssh_command" {
  value       = var.dns_zone_name != "" ? "ssh ${var.admin_username}@${var.vm_hostname}.${trimsuffix(var.dns_domain, ".")}" : "ssh ${var.admin_username}@${google_compute_address.box_ip.address}"
  description = "SSH command to connect to the VM"
}

# Output the zone
output "vm_zone" {
  value       = google_compute_instance.box.zone
  description = "Zone where the VM was created"
}

# Output GPU configuration
output "gpu_config" {
  value = {
    type  = var.gpu_type
    count = var.gpu_count
  }
  description = "GPU configuration"
}

# Output admin username
output "admin_username" {
  value       = var.admin_username
  description = "Admin username for SSH"
}

