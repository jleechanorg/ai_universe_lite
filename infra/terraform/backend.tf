###############################################################################
# backend.tf — GCS remote state configuration.
#
# The actual bucket "ai-universe-tfstate" and prefix are listed here so that
# `terraform init` (with the default backend) will reach for remote state in
# CI. For local validation / iteration, run:
#
#   terraform init -backend=false
#
# which skips the network call entirely (see README §"Local development").
###############################################################################

terraform {
  backend "gcs" {
    bucket = "ai-universe-tfstate"
    prefix = "ai-universe-lite/phase-1"
  }
}
