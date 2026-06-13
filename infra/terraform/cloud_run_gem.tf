###############################################################################
# cloud_run_gem.tf — the per-gem Cloud Run service template.
#
# Every gem in every env gets exactly one google_cloud_run_service. Image,
# env vars, secrets, and resource limits are derived from var.* so the
# deployer stage (in the backend lane) can call this with gem_id, env, and
# image_tag only.
#
# Mirrors the Phase 0 deploy contract:
#   - 1 vCPU, 512Mi memory, 300s timeout, min 0, max 10, concurrency 80
#   - NODE_ENV=production, PORT=8080, MCP_SERVER_PORT=8080
#   - STORAGE_TYPE=firestore, MCP_SESSION_STORE=memory (opt-in redis later)
###############################################################################

# ---- Service ----------------------------------------------------------------
# Convention: `gem_<purpose>_<env>` -> `gem_cloud_run_<env>` (purpose is
# `cloud_run` for the Cloud Run service). The service *name* itself uses
# `gem-<gem_id>-<env>` so the Cloud Run UI shows a friendly identifier and
# existing log filters keep matching.
resource "google_cloud_run_service" "gem_cloud_run" {
  name     = "gem-${var.gem_id}-${var.env}"
  project  = var.project
  location = var.region

  # Phase 1: still pull from gcr.io (Phase 0). Phase 2: artifact_registry.tf
  # will switch the image host to <region>-docker.pkg.dev/<project>/gems.
  template {
    spec {
      service_account_name = google_service_account.gem_runtime.email

      # Resource envelope from the deploy contract. Do not loosen
      # concurrency below 80 without checking with the gem author; some
      # gems (e.g. ai-rpg) assume at least 80 concurrent fan-out per
      # instance.
      container_concurrency = 80
      timeout_seconds       = 300

      containers {
        image = "${var.region}-gcr.io/${var.project}/gem-${var.gem_id}:${var.image_tag}"

        # Port contract — gem-server.tmpl binds 8080, Cloud Run must agree.
        ports {
          name           = "http1"
          container_port = 8080
        }

        # Resource limits from the deploy contract.
        resources {
          limits = {
            cpu    = "1"
            memory = "512Mi"
          }
        }

        # Base env vars — every gem gets these. Additional vars (e.g.
        # MCP_SESSION_STORE=redis) are set by the deployer stage before
        # it invokes this module.
        env {
          name  = "NODE_ENV"
          value = "production"
        }
        env {
          name  = "PORT"
          value = "8080"
        }
        env {
          name  = "MCP_SERVER_PORT"
          value = "8080"
        }
        env {
          name  = "MCP_SESSION_STORE"
          value = "memory"
        }
        env {
          name  = "STORAGE_TYPE"
          value = "firestore"
        }
        env {
          name  = "GEM_ID"
          value = var.gem_id
        }
        env {
          name  = "GEM_VERSION"
          value = var.image_tag
        }
        env {
          name  = "REF_BUCKET"
          value = google_storage_bucket.refs.name
        }
        env {
          name  = "FIREBASE_PROJECT_ID"
          value = var.firebase_project_id
        }
        env {
          name  = "FIRESTORE_PROJECT_ID"
          value = var.firebase_project_id
        }

        # LLM-provider secrets. Only bind the ones the gem actually
        # needs (var.secrets) so a gem can't accidentally read a secret
        # it never declared.
        dynamic "env" {
          for_each = toset(var.secrets)
          content {
            name = env.value
            value_from {
              secret_key_ref {
                name = env.value
                key  = "latest"
              }
            }
          }
        }

        # Startup probe: gem-server.tmpl exposes /healthz within 5s on
        # a healthy boot. The first probe gives it 10s; the per-probe
        # timeout matches Cloud Run's max (240s) for the liveness probe.
        startup_probe {
          http_get {
            path = "/healthz"
            port = 8080
          }
          initial_delay_seconds = 0
          period_seconds        = 5
          failure_threshold     = 6
          timeout_seconds       = 10
        }
        liveness_probe {
          http_get {
            path = "/healthz"
            port = 8080
          }
          period_seconds  = 30
          timeout_seconds = 5
          failure_threshold = 3
        }
      }
    }

    metadata {
      annotations = {
        # We don't want autoscaling to 0 in prod because cold starts are
        # 5-8s and that breaks the gem-builder latency budget. Dev
        # still scales to 0 to save money.
        "autoscaling.knative.dev/minScale" = var.env == "dev" ? "0" : "1"
        "autoscaling.knative.dev/maxScale" = "10"
        "run.googleapis.com/launch-stage"  = "GA"
      }
      labels = {
        gem     = var.gem_id
        env     = var.env
        purpose = "gem-runtime"
      }
    }
  }

  traffic {
    percent         = 100
    latest_revision = true
  }

  # No autogenerated domain; we'll front every gem with the same
  # gateway URL via a load balancer in Phase 2.
  autogenerate_revision_name = true

  lifecycle {
    # Cloud Run gives every deploy a new revision. The old revision
    # sticks around in metadata even after `terraform destroy`, so we
    # never want `create_before_destroy` confusion here.
    create_before_destroy = false
    # The image is updated every deploy, so we don't want Terraform
    # detecting an unrelated image-tag drift as a forced replacement.
    ignore_changes = [template[0].spec[0].containers[0].image]
  }
}

# ---- Public access ----------------------------------------------------------
# Gems are publicly invocable. The deploy contract says no auth at the
# Cloud Run edge; auth lives at the MCP tool layer. We bind the
# `roles/run.invoker` to `allUsers` (with an environment-conditional
# warning in the README that prod gating is a Phase 2 concern).
resource "google_cloud_run_service_iam_member" "gem_cloud_run_public" {
  location = google_cloud_run_service.gem_cloud_run.location
  project  = google_cloud_run_service.gem_cloud_run.project
  service  = google_cloud_run_service.gem_cloud_run.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
