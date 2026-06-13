terraform {
  required_version = ">= 1.5.0, < 2.0.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 5.0"
    }
  }

  # The real backend is declared in backend.tf so the bucket name and
  # prefix are easy to discover. Keeping the `terraform {}` block free of
  # backend config also lets `terraform init -backend=false` work locally
  # (acceptance criterion #1) without needing a real GCS bucket.
}

provider "google" {
  project = var.project
  region  = var.region
}

provider "google-beta" {
  project = var.project
  region  = var.region
}
