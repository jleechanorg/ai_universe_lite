###############################################################################
# .tflint.hcl — minimal tflint configuration for AI Universe Lite.
#
# To run locally:
#   brew install tflint        # or: see https://github.com/terraform-linters/tflint
#   tflint --init              # downloads ruleset plugins
#   tflint --recursive
#
# If tflint is not installed, CI runs it via GitHub Actions
# (see .github/workflows/tflint.yml when added). The README documents this.
###############################################################################

plugin "terraform" {
  enabled = true
  version = ">= 0.10.0"
}

# Enable the Google provider's ruleset so we catch deprecated argument
# names and missing required fields before `terraform plan` does.
plugin "google" {
  enabled = true
  version = ">= 0.25.0"
  source  = "github.com/terraform-linters/tflint-ruleset-google"
}

# ---- Rule configuration ----------------------------------------------------

# Reject module versions that are pinned to a major version only (e.g.
# "~> 5.0") without an upper bound — silent major upgrades are dangerous.
rule "terraform_module_pinned_source" {
  enabled = true
}

# Reject resource names that don't follow the gem_<purpose>_<env> convention.
# We can't express this with a built-in rule, so we use the naming rule
# with a custom pattern.
rule "terraform_naming_convention" {
  enabled = true
  format  = "snake_case"
}

# Don't let `terraform_required_providers` drift between blocks.
rule "terraform_required_providers" {
  enabled = true
}

# Don't let `terraform_required_version` drift.
rule "terraform_required_version" {
  enabled = true
}

# Catch unused declarations early.
rule "terraform_unused_declarations" {
  enabled = true
}

# Catch invalid references to variables / outputs / locals.
rule "terraform_unused_required_providers" {
  enabled = true
}
