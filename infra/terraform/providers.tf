terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
  backend "gcs" {
    bucket = "ai-universe-tfstate"
    prefix = "ai-universe-lite"
  }
}

provider "google" {
  project = "ai-universe-2025"
  region  = "us-central1"
}
