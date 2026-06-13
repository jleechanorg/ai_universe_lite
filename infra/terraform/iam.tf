###############################################################################
# iam.tf — service accounts and project-level IAM for the gem runtime.
#
# The original Phase 0 service account (ai-universe-lite-gem-runtime) is kept
# here verbatim so existing bindings to it survive the file move from
# main.tf. New role bindings (Artifact Registry reader, Cloud Run invoker,
# Secret Manager accessor for the per-gem secret subset) are added below
# following the `gem_<purpose>_<env>` naming convention.
###############################################################################

# ---- Per-gem runtime service account ----------------------------------------
# Each gem-in-env gets its own runtime SA. The Phase 0 SA
# "ai-universe-lite-gem-runtime" remains for backward compatibility and is
# also used as a fallback by gems that haven't migrated to per-gem SAs yet.
resource "google_service_account" "gem_runtime" {
  account_id   = "ai-universe-lite-gem-${var.gem_id}-${var.env}"
  display_name = "AI Universe Lite — gem ${var.gem_id} (${var.env}) runtime"
  description  = "Identity used by Cloud Run when running the ${var.gem_id} gem in ${var.env}."
}

# Legacy Phase 0 SA — kept so existing resources that reference it do not
# break during the Phase 1 rollout. Safe to remove in Phase 2 once every
# gem uses the per-gem SA above.
resource "google_service_account" "gem_runtime_legacy" {
  account_id   = "ai-universe-lite-gem-runtime"
  display_name = "AI Universe Lite Gem Runtime (legacy)"
}

# ---- Project-level role bindings -------------------------------------------

# Secret Manager: the runtime SA can read any of the six LLM-provider
# secrets listed in var.secrets. The conditional in secret_manager.tf is the
# authoritative gate; this is the broad per-project grant that lets the SA
# hit Secret Manager at all.
resource "google_project_iam_member" "gem_runtime_secret_accessor" {
  project = var.project
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.gem_runtime.email}"
}

# Artifact Registry: pull images from the new `gems` repository (Phase 2)
# and from GCR during the transition. `reader` lets the runtime SA pull
# images at instance startup.
resource "google_project_iam_member" "gem_runtime_artifact_reader" {
  project = var.project
  role    = "roles/artifactregistry.reader"
  member  = "serviceAccount:${google_service_account.gem_runtime.email}"
}

# Cloud Run invoker: allows the runtime SA to call other Cloud Run services
# (e.g. an upstream MCP service) when the gem needs to chain calls. Without
# this, the SA can deploy but not invoke.
resource "google_project_iam_member" "gem_runtime_run_invoker" {
  project = var.project
  role    = "roles/run.invoker"
  member  = "serviceAccount:${google_service_account.gem_runtime.email}"
}

# Legacy SA — keep the original secretAccessor binding alive so the v1
# `ai-rpg` demo gem (which still uses the shared SA) keeps working.
resource "google_project_iam_member" "gem_runtime_legacy_secret_accessor" {
  project = var.project
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.gem_runtime_legacy.email}"
}

# ---- BigQuery audit log sink (per environment) -----------------------------
# Audit logs from Cloud Run, IAM, and Secret Manager flow into a per-env
# BigQuery dataset. The `gem_audit_log` Firestore collection is for
# application-level audit events; the BigQuery sink captures platform-level
# events that the security team queries directly.
#
# Address convention: `gem_<purpose>_<env>` -> `gem_audit_sink_<env>`.
resource "google_bigquery_dataset" "gem_audit" {
  dataset_id  = "gem_audit_${var.env}"
  project     = var.project
  location    = var.region
  description = "Per-environment audit log sink for the ${var.env} gem runtime. Populated by the logging sink below."

  labels = {
    gem     = var.gem_id
    env     = var.env
    purpose = "audit"
  }
}

# The actual sink. The `destination` is the BigQuery dataset created above.
# Filter narrows to the gems + service accounts we care about, so we don't
# pay for unrelated platform logs.
resource "google_logging_project_sink" "gem_audit" {
  name                   = "gem-audit-sink-${var.env}"
  project                = var.project
  destination            = "bigquery.googleapis.com/projects/${var.project}/datasets/${google_bigquery_dataset.gem_audit.dataset_id}"
  filter                 = <<-EOT
    resource.type=("cloud_run_revision" OR "iam_role" OR "secret_manager" OR "service_account")
    AND (
      resource.labels.service_name=~"^gem-.*-${var.env}$"
      OR protoPayload.serviceName="secretmanager.googleapis.com"
      OR protoPayload.authenticationInfo.principalEmail=~"ai-universe-lite-gem.*@.*\\.iam\\.gserviceaccount\\.com"
    )
  EOT
  unique_writer_identity = true
}

# The sink's writer identity needs bigquery.dataEditor on the dataset,
# otherwise BQ rejects the streamed rows.
resource "google_bigquery_dataset_iam_member" "gem_audit_writer" {
  dataset_id = google_bigquery_dataset.gem_audit.dataset_id
  project    = var.project
  role       = "roles/bigquery.dataEditor"
  member     = google_logging_project_sink.gem_audit.writer_identity
}
