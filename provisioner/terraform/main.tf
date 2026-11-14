data "google_compute_subnetwork" "box" {
  name   = var.subnetwork
  region = var.region
}

resource "google_compute_instance" "box" {
  name         = "gp-${var.box_id}"
  machine_type = var.machine_type
  zone         = var.zone

  labels = {
    gpushed = "box"
    box_id  = var.box_id
  }

  boot_disk {
    initialize_params {
      image = "ubuntu-os-cloud/ubuntu-2204-lts"
      size  = 100
      type  = "pd-ssd"
    }
  }

  dynamic "guest_accelerator" {
    for_each = var.gpu_count > 0 ? [1] : []
    content {
      type  = var.gpu_type
      count = var.gpu_count
    }
  }

  # GPU instances can't live-migrate.
  scheduling {
    on_host_maintenance = "TERMINATE"
    automatic_restart   = true
  }

  # Secure Boot off so the NVIDIA kernel module loads.
  shielded_instance_config {
    enable_secure_boot          = false
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  network_interface {
    subnetwork = data.google_compute_subnetwork.box.self_link
    access_config {} # ephemeral public IPv4
  }

  # No service_account block: the box gets no Google credentials, so the user
  # who owns it can't reach anything else in our project.

  metadata = {
    ssh-keys               = "${var.ssh_user}:${var.ssh_public_key} gpushed"
    block-project-ssh-keys = "true"
    enable-oslogin         = "FALSE"
  }

  tags = ["gpushed-box"]

  metadata_startup_script = templatefile("${path.module}/scripts/startup-wrapper.sh", {
    setup_script = templatefile("${path.module}/scripts/setup.sh", {})
  })

  desired_status            = var.desired_status
  allow_stopping_for_update = true
}

output "ip" {
  # Empty while the box is stopped.
  value = try(google_compute_instance.box.network_interface[0].access_config[0].nat_ip, "")
}

output "zone" {
  value = google_compute_instance.box.zone
}
