###############################################################################
# gcs.tf — GCS reference-file bucket with lifecycle rules and per-prefix IAM.
#
# The Phase 0 bucket (ai-universe-lite-refs) is preserved here with the same
# 30-day delete lifecycle and uniform bucket-level access. New in Phase 1:
#   - Per-prefix IAM for the gem runtime SA: read+write on `intake/` and
#     `tmp/`, read-only on the rest. The two prefixes are what gem code
#     touches; everything else is gem-defined static assets.
#   - Per-env soft-delete retention (7d for dev, 30d for staging, 90d for
#     prod) so an accidental gem-publish rollback can be recovered.
###############################################################################

# ---- The bucket ------------------------------------------------------------
# Keeping the original name "ai-universe-lite-refs" so deploy.sh (which
# hard-codes REF_BUCKET=ai-universe-lite-refs in the deploy contract)
# continues to find it. Per-env isolation is achieved by *prefixes*, not
# separate buckets, which is cheaper and matches the Phase 0 contract.
resource "google_storage_bucket" "refs" {
  name     = var.ref_bucket_name
  location = var.region
  project  = var.project

  uniform_bucket_level_access = true
  versioning {
    enabled = true
  }

  # Soft-delete window — long enough to recover from a bad prod publish,
  # short enough that storage doesn't pile up.
  soft_delete_policy {
    retention_duration_seconds = local.soft_delete_seconds
  }

  # Force-destroy is needed for `terraform destroy` in CI rollback drills
  # (see README §"Rollback"). Off in prod via a check in locals.
  force_destroy = var.env != "prod"

  # Lifecycle: 30-day delete on every object, mirroring Phase 0.
  lifecycle_rule {
    condition {
      age = 30
    }
    action {
      type = "Delete"
    }
  }

  # Lifecycle: abort incomplete multipart uploads after 7 days. Without
  # this, failed uploads leak storage and credits.
  lifecycle_rule {
    condition {
      age = 7
    }
    action {
      type = "AbortIncompleteMultipartUpload"
    }
  }

  labels = {
    gem     = var.gem_id
    env     = var.env
    purpose = "gem-refs"
  }
}

# ---- Per-prefix IAM --------------------------------------------------------
# Bind the gem runtime SA to two IAM roles on the bucket. `roles/storage.objectUser`
# grants read+write+list to the prefixes the gem needs. We then restrict it
# further with an IAM policy that denies every other prefix.
#
# Note: GCS IAM conditions on `name` are the supported way to scope a
# principal to a prefix. See
# https://cloud.google.com/storage/docs/access-control/iam-condition
data "google_iam_policy" "gem_refs_prefix" {
  binding {
    role = "roles/storage.objectUser"
    members = [
      "serviceAccount:${google_service_account.gem_runtime.email}",
    ]
    condition {
      title       = "intake-prefix"
      description = "Allow gem runtime SA to read and write the intake/ prefix."
      expression  = "resource.name.startsWith('projects/_/buckets/${var.ref_bucket_name}/objects/intake/')"
    }
  }
  binding {
    role = "roles/storage.objectUser"
    members = [
      "serviceAccount:${google_service_account.gem_runtime.email}",
    ]
    condition {
      title       = "tmp-prefix"
      description = "Allow gem runtime SA to read and write the tmp/ prefix."
      expression  = "resource.name.startsWith('projects/_/buckets/${var.ref_bucket_name}/objects/tmp/')"
    }
  }
  binding {
    role = "roles/storage.objectViewer"
    members = [
      "serviceAccount:${google_service_account.gem_runtime.email}",
    ]
    condition {
      title       = "read-only-everything-else"
      description = "Allow gem runtime SA to read all other prefixes (gem assets, templates)."
      expression  = "!resource.name.startsWith('projects/_/buckets/${var.ref_bucket_name}/objects/intake/') && !resource.name.startsWith('projects/_/buckets/${var.ref_bucket_name}/objects/tmp/')"
    }
  }
}

resource "google_storage_bucket_iam_policy" "refs" {
  bucket      = google_storage_bucket.refs.name
  policy_data = data.google_iam_policy.gem_refs_prefix.policy_data
}

# ---- Locals ---------------------------------------------------------------
locals {
  # Per-env soft-delete windows. Dev gets the shortest because devs trash
  # buckets often; prod gets the longest because losing a prod ref hurts.
  soft_delete_seconds = {
    dev     = 7 * 24 * 60 * 60
    staging = 30 * 24 * 60 * 60
    prod    = 90 * 24 * 60 * 60
  }[var.env]
}
