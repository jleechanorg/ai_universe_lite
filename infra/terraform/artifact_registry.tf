###############################################################################
# artifact_registry.tf — Artifact Registry repository for the Phase 2
# migration off of gcr.io.
#
# We create the repository now (Phase 1) so IAM bindings and CI plumbing
# can be tested against an empty repo. The actual image-push migration is
# a Phase 2 follow-up; the deploy contract still says gcr.io for now.
#
# Format: DOCKER (so gem-author docker push <host>/gems/gem-<id>:<tag> works).
# Mode:  STANDARD (not VIRTUAL — VIRTUAL would be the right answer for a
#        single-name multi-backend, but the migration is one-shot, not
#        virtualized).
###############################################################################

resource "google_artifact_registry_repository" "gems" {
  project       = var.project
  location      = var.region
  repository_id = "gems"
  format        = "DOCKER"
  description   = "Per-gem container images. Phase 1: read-only, populated during the gcr.io migration in Phase 2."

  # Cleanup policy: keep only the last 50 tags per image. Stale dev tags
  # accumulate fast and burn storage.
  cleanup_policy_dry_run = false
  cleanup_policies {
    id     = "keep-recent-50"
    action {
      type = "KEEP"
      most_recent_versions {
        keep_count = 50
      }
    }
  }
  cleanup_policies {
    id     = "delete-untagged"
    action {
      type = "DELETE"
      condition {
        tag_state    = "UNTAGGED"
        older_than   = "604800s" # 7 days
      }
    }
  }

  labels = {
    gem     = var.gem_id
    env     = var.env
    purpose = "gem-images"
  }
}

# The runtime SA can *read* (pull) from this repository. Pushing is
# reserved for CI service accounts (WIF in Phase 2).
resource "google_artifact_registry_repository_iam_member" "gems_runtime_reader" {
  project    = var.project
  location   = google_artifact_registry_repository.gems.location
  repository = google_artifact_registry_repository.gems.name
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.gem_runtime.email}"
}
