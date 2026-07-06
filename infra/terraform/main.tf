###############################################################################
# main.tf — entry point for the AI Universe Lite gem infrastructure module.
#
# The actual resources are split across the following files for readability
# and so reviewers can scope their diffs to one concern at a time:
#
#   - providers.tf     : Terraform + provider config (google, google-beta)
#   - backend.tf       : GCS remote state configuration
#   - variables.tf     : input variables (gem_id, env, region, project, secrets)
#   - outputs.tf       : values emitted to the deployer stage
#   - cloud_run_gem.tf : the per-gem google_cloud_run_service
#   - iam.tf           : service accounts, project-level IAM, BigQuery audit sink
#   - gcs.tf           : ref-file GCS bucket + per-prefix IAM
#   - firestore.tf     : Firestore database + composite indexes
#   - artifact_registry.tf : Phase 2 gems repository
#   - secret_manager.tf    : per-secret IAM for the six LLM providers
#   - scheduler.tf     : Cloud Scheduler jobs for ref GC + preview-PR cleanup
#
# There is intentionally no `resource {}` block in this file. Everything is
# owned by the file that best explains its purpose. The `terraform_block` and
# provider configuration still live in `providers.tf` and `backend.tf`.
#
# If you are looking for the resource that creates the Cloud Run service,
# open `cloud_run_gem.tf`. If you are looking for the runtime service account,
# open `iam.tf`. If you are looking for the GCS ref bucket, open `gcs.tf`.
###############################################################################
