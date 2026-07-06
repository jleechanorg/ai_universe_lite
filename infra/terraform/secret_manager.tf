###############################################################################
# secret_manager.tf — IAM bindings for the six canonical LLM-provider secrets.
#
# The secrets themselves are NOT created here. They live in Secret Manager
# already (manually rotated by the platform team) and are referenced by
# name. This file's job is to make sure the gem runtime SA can read exactly
# the subset of secrets declared in `var.secrets`.
#
# Why a for_each over the list (and not just the project-level grant in
# iam.tf)? Because we want a separate `google_secret_manager_secret_iam_member`
# resource per secret so the Terraform plan is explicit about which secrets
# are being granted. The project-level `roles/secretmanager.secretAccessor`
# in iam.tf remains as a coarse-grained fallback.
###############################################################################

# Six canonical LLM-provider secret names. The variables.tf validation
# block rejects any secret outside this list, so we can safely iterate
# `var.secrets` and grant per-secret.
locals {
  llm_secret_names = [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "PERPLEXITY_API_KEY",
    "OPENROUTER_API_KEY",
    "GROK_API_KEY",
  ]
}

# Grant the gem runtime SA accessor on every secret the gem declares.
resource "google_secret_manager_secret_iam_member" "gem_runtime_secrets" {
  for_each  = toset(var.secrets)
  project   = var.project
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.gem_runtime.email}"
}
