###############################################################################
# firestore.tf — Firestore database and index definitions.
#
# The gem runtime writes three application-level collections to Firestore:
#   - gem_runs        : one document per gem invocation (used for analytics)
#   - gems            : gem metadata (id, version, owner, visibility)
#   - gem_audit_log   : application-level audit events (BigQuery in iam.tf
#                       captures platform-level events; this is for the
#                       app-emitted "user did X" type logs)
#
# Indexes below match the queries the gem-builder pipeline issues:
#   - "show me runs for gem X in the last hour, newest first"
#   - "show me all public gems in the gallery"
#   - "audit events for gem X between T1 and T2"
#
# The Firestore *database* itself is shared with the Firebase project
# "ai-universe-b3551" (the same one the deploy contract hard-codes). If
# that project is ever split per-env, this resource gets cloned with a
# per-env database_id and a re-pointing of FIRESTORE_PROJECT_ID in
# variables.tf.
###############################################################################

# The Firestore database. We use the native (Firestore) API; the legacy
# Datastore mode is intentionally avoided because the gem runtime talks
# Firestore SDK v9+.
resource "google_firestore_database" "gem_db" {
  project     = var.firebase_project_id
  name        = "(default)"
  location_id = var.region
  type        = "FIRESTORE_NATIVE"

  # Concurrency mode: strong consistency on documents the gem writes;
  # optimistic on reads. This is the cheapest tier and matches what
  # ai_universe uses.
  concurrency_mode = "OPTIMISTIC"

  # App Engine integration is OFF — the gems don't talk to the default
  # GAE namespace.
  app_engine_integration_mode = "DISABLED"
}

# ---- Indexes ---------------------------------------------------------------
# The Firestore Terraform provider exposes the index resource for
# *composite* indexes. Single-field indexes are auto-created.

# gem_runs: query by (gem_id ASC, created_at DESC) for the gem-detail page.
resource "google_firestore_index" "gem_runs_gem_id_created_at" {
  project    = var.firebase_project_id
  database   = google_firestore_database.gem_db.name
  collection = "gem_runs"

  fields {
    field_path = "gem_id"
    order      = "ASCENDING"
  }
  fields {
    field_path = "created_at"
    order      = "DESCENDING"
  }
}

# gem_runs: query by (user_id ASC, created_at DESC) for "my recent runs".
resource "google_firestore_index" "gem_runs_user_id_created_at" {
  project    = var.firebase_project_id
  database   = google_firestore_database.gem_db.name
  collection = "gem_runs"

  fields {
    field_path = "user_id"
    order      = "ASCENDING"
  }
  fields {
    field_path = "created_at"
    order      = "DESCENDING"
  }
}

# gems: query public, published gems in the gallery.
resource "google_firestore_index" "gems_visibility_published" {
  project    = var.firebase_project_id
  database   = google_firestore_database.gem_db.name
  collection = "gems"

  fields {
    field_path = "visibility"
    order      = "ASCENDING"
  }
  fields {
    field_path = "published_at"
    order      = "DESCENDING"
  }
}

# gem_audit_log: query by (gem_id ASC, ts DESC) for the per-gem audit view.
resource "google_firestore_index" "gem_audit_log_gem_id_ts" {
  project    = var.firebase_project_id
  database   = google_firestore_database.gem_db.name
  collection = "gem_audit_log"

  fields {
    field_path = "gem_id"
    order      = "ASCENDING"
  }
  fields {
    field_path = "ts"
    order      = "DESCENDING"
  }
}
