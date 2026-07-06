# Terraform — AI Universe Lite

Infrastructure for the gem-builder pipeline + per-gem Cloud Run services.

## Resources

| Module | Resource | Purpose |
|--------|----------|---------|
| `gcs.tf` | `google_storage_bucket.ai_universe_lite_refs` | Ref uploads (`intake/`, `tmp/` prefixes), 30-day lifecycle |
| `gcs.tf` | `google_storage_bucket_iam_member` | gem-runtime SA read+write to `intake/`, read-only to `tmp/` |
| `iam.tf` | `google_service_account.gem_runtime` | `ai-universe-lite-gem-runtime@...` with `roles/secretmanager.secretAccessor` |
| `cloud_run_gem.tf` | `google_cloud_run_service.gem` | Per-gem service template (gem_id, env, image_tag as vars) |
| `firestore.tf` | `google_firestore_database.gems` + composite indexes | gem_runs, gems, gem_audit_log |
| `artifact_registry.tf` | `google_artifact_registry_repository.gems` | Phase 2 migration target from `gcr.io` |
| `secret_manager.tf` | IAM for 6 LLM provider secrets | OPENAI, ANTHROPIC, GEMINI, PERPLEXITY, OPENROUTER, GROK |
| `scheduler.tf` | `google_cloud_scheduler_job` × 2 | ref GC (30d) + gem-preview-pr cleanup (6h TTL) |

## Quickstart (local)

```bash
cd infra/terraform
terraform init -backend=false           # skip remote state for local
terraform validate
terraform fmt -check -recursive
tflint --recursive                      # optional, requires `brew install tflint`
```

## Apply (CI / GitHub Actions only)

```bash
# Prod is blocked locally; only GitHub Actions can apply.
cd infra/terraform
terraform init                          # uses ai-universe-tfstate GCS bucket
terraform plan -var-file=prod.tfvars    # or staging.tfvars / dev.tfvars
terraform apply -auto-approve -var-file=prod.tfvars
```

### Variable files (NOT committed; create on first apply)

`dev.tfvars`:
```hcl
env         = "dev"
gem_id      = "ai-rpg"
image_tag   = "0.1.0"
project_id  = "ai-universe-2025"
region      = "us-central1"
ref_bucket  = "ai-universe-lite-refs"
secrets     = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "PERPLEXITY_API_KEY", "OPENROUTER_API_KEY", "GROK_API_KEY"]
```

`staging.tfvars` and `prod.tfvars` follow the same shape; the deployer (Phase 7.5) passes the matching file per env.

## Envs

| Env | Service | Project | Used by |
|-----|---------|---------|---------|
| `dev` | `gem-<id>-dev` | `ai-universe-2025` | Local testing, `npm run gem:e2e` deploys here |
| `staging` | `gem-<id>-staging` | `ai-universe-2025` | Pre-prod smoke tests |
| `prod` | `gem-<id>-prod` | `ai-universe-2025` | Production traffic; only deploys via `gem-publish.yml` with manual approval |

## Rollback

```bash
# Roll back a single gem's Cloud Run service to the previous revision
gcloud run services update-traffic gem-<id>-prod --to-revisions=<gem-id>-prod-00042-abc=100

# Destroy a single resource (use sparingly)
terraform destroy -target=google_cloud_run_service.gem

# Destroy the whole stack (DANGER)
terraform destroy -var-file=dev.tfvars
```

## Prod-guard (mirrors `ai_universe/deploy.sh` lines 162-193)

Local `prod` deploys are **always blocked** by the deployer script. The only path to prod is the `gem-publish.yml` GitHub Actions workflow with manual approval. Override (`ALLOW_LOCAL_PROD_DEPLOY=true`) is Jeffrey-only and never committed.

## Outputs

| Output | Used by |
|--------|---------|
| `gem_cloud_run_url` | Stage 7.5 deployer (writes to `gems/<id>` registry) + Stage 8 registry-hooks (frontend embed) |
| `gem_service_account_email` | Stage 7.5 deployer (`--service-account` flag) |
| `gem_image_registry` | Stage 4 builder (image tag) + Stage 7.5 deployer (`gcloud builds submit`) |
| `ref_bucket` | Stage 1 intake (GCS ref move) + every gem's `ctx.readTextRef` (loader) |
| `firestore_database_id` | `backend/src/stores/firestore.ts` init |
| `artifact_registry_repo` | Phase 2 deployer migration from `gcr.io` |

## State

Remote state in `gs://ai-universe-tfstate/ai-universe-lite/`. Locking via GCS object versioning. State access requires `roles/storage.objectAdmin` on the bucket.

## CI

`infra-terraform-validate.yml` (Phase 1) runs `terraform fmt -check -recursive && terraform validate` on every PR touching `infra/terraform/`.
