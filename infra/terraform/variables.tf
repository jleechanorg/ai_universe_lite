###############################################################################
# variables.tf — input variables for AI Universe Lite gem infrastructure.
#
# Resource addresses follow the convention `gem_<purpose>_<env>` so a single
# state file can host multiple gems in multiple environments.
#
# Required: every deploy of a new gem in a new env must pass gem_id and env.
###############################################################################

variable "gem_id" {
  description = <<-EOT
    Unique identifier for the gem being deployed (e.g. "ai-rpg", "recipe-finder").
    Used as a prefix for all gem-scoped resource names (Cloud Run service, image
    tag, GCS object prefixes) and as the value of the GEM_ID env var injected
    into the gem container.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$", var.gem_id))
    error_message = "gem_id must be 3-32 chars, lowercase alphanumeric and dashes, and must not start or end with a dash."
  }
}

variable "env" {
  description = <<-EOT
    Deployment environment. One of:
      - "dev"     : local developer scratch space, no SLA, fastest iteration
      - "staging" : pre-prod mirror of prod config, used for QA
      - "prod"    : production; may only be applied via CI (see README "prod-guard")
    Drives resource naming, lifecycle aggressiveness, and ingress policy.
  EOT
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.env)
    error_message = "env must be one of: dev, staging, prod."
  }
}

variable "region" {
  description = <<-EOT
    GCP region for the gem's Cloud Run service, Artifact Registry, Scheduler
    jobs, and Firestore. Must match the region of the project-level resources
    (default: us-central1 to mirror the deploy contract).
  EOT
  type        = string
  default     = "us-central1"

  validation {
    condition     = can(regex("^[a-z]+-[a-z]+[0-9]$", var.region))
    error_message = "region must be a valid GCP region (e.g. us-central1, europe-west1)."
  }
}

variable "project" {
  description = <<-EOT
    GCP project ID that owns the gem's resources. Defaults to "ai-universe-2025"
    which is the project the deploy contract targets.
  EOT
  type        = string
  default     = "ai-universe-2025"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project))
    error_message = "project must be a valid GCP project ID (6-30 chars, lowercase, dashes allowed)."
  }
}

variable "secrets" {
  description = <<-EOT
    List of LLM-provider Secret Manager secrets the gem runtime is allowed to
    read. Each entry must be one of the six canonical providers; the gem author
    declares which subset their gem needs. The IAM bindings in `secret_manager.tf`
    are conditional on this list and will fail closed if a non-canonical secret
    is requested.
  EOT
  type        = list(string)
  default     = []

  validation {
    condition = alltrue([
      for s in var.secrets : contains(
        [
          "OPENAI_API_KEY",
          "ANTHROPIC_API_KEY",
          "GEMINI_API_KEY",
          "PERPLEXITY_API_KEY",
          "OPENROUTER_API_KEY",
          "GROK_API_KEY",
        ],
        s
      )
    ])
    error_message = "secrets must be a subset of: OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, PERPLEXITY_API_KEY, OPENROUTER_API_KEY, GROK_API_KEY."
  }
}

variable "image_tag" {
  description = <<-EOT
    Container image tag (e.g. "v1.2.3", "pr-42-abc123", "sha-9f8e7d6").
    Passed to the gem Cloud Run service; in Phase 1 we still pull from
    gcr.io, in Phase 2 the artifact_registry module will rewrite the image
    path to point at the new gems repository.
  EOT
  type        = string
  default     = "latest"

  validation {
    condition     = can(regex("^[A-Za-z0-9._-]{1,128}$", var.image_tag))
    error_message = "image_tag must be 1-128 chars of [A-Za-z0-9._-] (e.g. v1.2.3 or sha-deadbeef)."
  }
}

variable "firebase_project_id" {
  description = <<-EOT
    Project ID for the Firestore/Firebase client used by the gem at runtime.
    Defaults to the existing "ai-universe-b3551" Firebase project (shared
    with ai_universe for now; will split per-env in Phase 2).
  EOT
  type        = string
  default     = "ai-universe-b3551"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.firebase_project_id))
    error_message = "firebase_project_id must be a valid GCP/Firebase project ID."
  }
}

variable "ref_bucket_name" {
  description = <<-EOT
    Name of the GCS bucket that holds the gem's reference files (uploads the
    gem will be served). Defaults to "ai-universe-lite-refs-<env>" so dev /
    staging / prod do not share state. This bucket is created in `gcs.tf`.
  EOT
  type        = string
  default     = "ai-universe-lite-refs"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]{2,60}[a-z0-9]$", var.ref_bucket_name))
    error_message = "ref_bucket_name must be a valid GCS bucket name (lowercase, dots/dashes allowed, 3-63 chars)."
  }
}
