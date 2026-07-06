###############################################################################
# scheduler.tf — Cloud Scheduler jobs for cleanup tasks.
#
# Two jobs, both driven by HTTP POST to a Cloud Run cleanup endpoint that
# the platform team maintains:
#
#   1. `gem_ref_gc`           — daily 30-day ref-file sweep.
#   2. `gem_preview_pr_cleanup` — hourly preview-PR cleanup, 6h TTL.
#
# The actual deletion logic lives in the platform cleanup service (not in
# Terraform); we just schedule the calls. The cleanup service is expected
# to read the relevant `GEM_ID` / `PR_NUMBER` from the request body and
# idempotently delete the matching Cloud Run service + GCS prefixes.
###############################################################################

# ---- Per-gem runtime service account used by the cleanup service ---------
# This is a separate SA from the per-gem runtime SA. The cleanup service
# needs to *delete* resources, which is more privileged than the runtime
# SA's read+invoke needs. We don't create this SA here — it already exists
# in the platform project (managed by the platform team) — but we reference
# it by name so the scheduler jobs can use it.
data "google_service_account" "cleanup_invoker" {
  project    = var.project
  account_id = "ai-universe-lite-cleanup-invoker"
}

# ---- 1. Ref GC: daily sweep of refs older than 30 days -------------------
resource "google_cloud_scheduler_job" "gem_ref_gc" {
  name        = "gem-ref-gc-${var.env}"
  project     = var.project
  region      = var.region
  description = "Daily GC sweep that deletes GCS ref objects older than 30 days. Calls the platform cleanup service."

  schedule  = "0 3 * * *" # 03:00 UTC daily
  time_zone = "UTC"

  http_target {
    http_method = "POST"

    # The cleanup service is a separate Cloud Run service. We hard-code
    # the URL here rather than terraform-deriving it to avoid a circular
    # dependency on the gem Cloud Run service we just created.
    uri = "https://cleanup-run-${var.env}-${var.project}.a.run.app/v1/refs/gc"

    body = base64encode(jsonencode({
      bucket        = google_storage_bucket.refs.name
      olderThanDays = 30
      env           = var.env
      gem_id        = var.gem_id
    }))

    headers = {
      "Content-Type" = "application/json"
    }

    oidc_token {
      service_account_email = data.google_service_account.cleanup_invoker.email
      audience              = "https://cleanup-run-${var.env}-${var.project}.a.run.app"
    }
  }

  retry_config {
    retry_count          = 3
    min_backoff_duration = "5s"
    max_backoff_duration = "60s"
    max_doublings        = 3
  }
}

# ---- 2. Preview PR cleanup: hourly check, 6h TTL -------------------------
# A gem-preview service (created by CI for every PR) auto-cleans after 6h
# by setting TTL on the underlying service. The scheduler job below is a
# safety net: hourly, it asks the cleanup service to nuke any preview
# service older than 6h that the TTL job missed.
resource "google_cloud_scheduler_job" "gem_preview_pr_cleanup" {
  name        = "gem-preview-pr-cleanup-${var.env}"
  project     = var.project
  region      = var.region
  description = "Hourly safety-net cleanup of PR preview services older than 6h. Skips prod (no PRs in prod)."

  # Skip prod — there are no PR preview services in prod.
  schedule  = var.env == "prod" ? "0 0 1 1 *" : "0 * * * *"
  time_zone = "UTC"

  http_target {
    http_method = "POST"
    uri         = "https://cleanup-run-${var.env}-${var.project}.a.run.app/v1/preview-pr/cleanup"

    body = base64encode(jsonencode({
      env            = var.env
      ttlHours       = 6
      gem_id         = var.gem_id
      idleShutoffHrs = 1
    }))

    headers = {
      "Content-Type" = "application/json"
    }

    oidc_token {
      service_account_email = data.google_service_account.cleanup_invoker.email
      audience              = "https://cleanup-run-${var.env}-${var.project}.a.run.app"
    }
  }

  retry_config {
    retry_count          = 3
    min_backoff_duration = "10s"
    max_backoff_duration = "120s"
    max_doublings        = 3
  }
}
