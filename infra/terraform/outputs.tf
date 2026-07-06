###############################################################################
# outputs.tf — values emitted for the deployer stage (in the backend lane).
#
# The deployer reads these to:
#   1. Set the GEM_ID / REF_BUCKET env vars on the deployed gem container.
#   2. Smoke-test the deployed URL with curl.
#   3. Tag the build with the service account email for audit.
#
# Every output the deployer needs is named exactly what the deploy contract
# expects (cloud_run_url, service_account_email, image_registry, ref_bucket).
###############################################################################

# The HTTPS URL of the deployed gem Cloud Run service. The deployer curls
# this immediately after `terraform apply` to confirm the revision is
# serving.
output "cloud_run_url" {
  description = "HTTPS URL of the gem's Cloud Run service. Use this for smoke tests and PR previews."
  value       = google_cloud_run_service.gem_cloud_run.status[0].url
}

# The runtime service account email. The deployer tags the gem release
# in the audit log with this so the security team can trace "who ran what".
output "service_account_email" {
  description = "Email of the gem runtime service account. Bind this when granting per-gem roles in user-specific resources."
  value       = google_service_account.gem_runtime.email
}

# The Artifact Registry / GCR image registry. The deployer pushes the
# new image here before triggering the next Terraform apply. Phase 1
# reads from gcr.io, Phase 2 will switch to the new `gems` repository.
output "image_registry" {
  description = "Container image registry host. Phase 1: gcr.io. Phase 2: <region>-docker.pkg.dev/<project>/gems."
  value       = "${var.region}-gcr.io/${var.project}/gem-${var.gem_id}"
}

# The GCS bucket name holding this gem's ref files. The deployer uses
# this for the REF_BUCKET env var and for setting the per-gem bucket
# policy.
output "ref_bucket" {
  description = "GCS bucket name where the gem stores its ref files."
  value       = google_storage_bucket.refs.name
}

# ---- Convenience compound outputs -----------------------------------------
# Roll up the per-gem-per-env identifiers so the deployer can write them
# to a single env file in one go.
output "gem_id" {
  description = "Echo of var.gem_id, for convenience in deploy scripts."
  value       = var.gem_id
}

output "env" {
  description = "Echo of var.env, for convenience in deploy scripts."
  value       = var.env
}

output "project" {
  description = "Echo of var.project, for convenience in deploy scripts."
  value       = var.project
}

output "region" {
  description = "Echo of var.region, for convenience in deploy scripts."
  value       = var.region
}

# The BigQuery audit dataset id, for compliance dashboards.
output "audit_dataset" {
  description = "BigQuery dataset id receiving platform-level audit logs for this gem+env."
  value       = google_bigquery_dataset.gem_audit.dataset_id
}

# The runtime region's Artifact Registry path for the gems repo (Phase 2).
output "artifact_registry_repo" {
  description = "Fully-qualified Artifact Registry repo path for the gems repository (Phase 2)."
  value       = "${var.region}-docker.pkg.dev/${var.project}/${google_artifact_registry_repository.gems.repository_id}"
}
