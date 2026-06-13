resource "google_storage_bucket" "refs" {
  name     = "ai-universe-lite-refs"
  location = "us-central1"
  uniform_bucket_level_access = true
  versioning { enabled = true }
  lifecycle_rule {
    condition { age = 30 }
    action { type = "Delete" }
  }
}

resource "google_container_registry" "gem_repo" {
  project  = "ai-universe-2025"
  location = "us"
}

resource "google_service_account" "gem_runtime" {
  account_id   = "ai-universe-lite-gem-runtime"
  display_name = "AI Universe Lite Gem Runtime"
}

resource "google_project_iam_member" "gem_runtime_secrets" {
  project = "ai-universe-2025"
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.gem_runtime.email}"
}
