---
name: opentofu
description: OpenTofu-specific features that Terraform guidance does not cover (state and plan encryption, `tofu test` with mocks and overrides, `.tofu` and `.tofutest.hcl` files). Use when the project runs `tofu` rather than `terraform`. For module structure, naming and general HCL practice use terraform-skill.
---

# OpenTofu

Facts below were read from the OpenTofu documentation (v1.13) on 2026-11-25. Before relying on a
feature, run `tofu version` and open the page for that version: https://opentofu.org/docs/

## First, which binary

Look for `tofu` in the CI workflow, the Makefile and `.tool-versions` before writing a command.
Never run `terraform` against state that `tofu` wrote with encryption enabled: it cannot read it.

## State and plan encryption

```hcl
terraform {
  encryption {
    key_provider "aws_kms" "main" {
      kms_key_id = var.state_kms_key_id
      region     = var.region
      key_spec   = "AES_256"
    }
    method "aes_gcm" "main" {
      keys = key_provider.aws_kms.main
    }
    state {
      method   = method.aes_gcm.main
      enforced = true
    }
    plan {
      method   = method.aes_gcm.main
      enforced = true
    }
  }
}
```

- Key providers: `pbkdf2` (passphrase), `aws_kms`, `gcp_kms`, `azure_vault`, `openbao`, `external`.
  Methods: `aes_gcm`, `external`, and `unencrypted` for migration only. Check each provider's
  arguments in the docs; the block above shows the shape, not every required field.
- Prefer a KMS key provider over `pbkdf2`. A passphrase must come from a variable or from
  `TF_ENCRYPTION`, never from a literal in the repository.
- `TF_ENCRYPTION` takes the same content without the `terraform {}` wrapper and overrides the
  code. Set `enforced = true` in code so that a run without the variable fails and does not write
  plaintext.
- Once enabled, the state cannot be read without the key. Before turning it on: back up the keys
  and an unencrypted copy of the state, and store both away from the state bucket.
- Do not rename a key provider or a method after data is encrypted, unless
  `encrypted_metadata_alias` is set.
- Encryption does not replace bucket access control, versioning or locking.

### Turning it on for existing state

1. Add `method "unencrypted" "migrate" {}` beside the new key provider and method.
2. In `state`, set the new `method` and add `fallback { method = method.unencrypted.migrate }`.
3. Run `tofu apply`. Reads fall back to plaintext; writes use the new method.
4. Remove the `fallback` block and the `unencrypted` method, then add `enforced = true`.

Do this in one environment first and confirm that `tofu plan` reads the state from a clean
checkout before repeating it elsewhere. This is a change to shared state: ask the user before
step 3.

## `tofu test`

- Files: `*.tftest.hcl` or `*.tofutest.hcl` (and `.json`), in the module directory or in `tests/`.
  When both `x.tftest.hcl` and `x.tofutest.hcl` exist only the `.tofutest` one loads: use
  `.tofutest.hcl` for tests that need OpenTofu-only features.
- A `run` block is one case. `command` defaults to `apply`, which creates real resources and
  destroys them at the end. Write `command = plan` unless the assertion needs a computed value.
- `run.<name>.<output>` resolves only after a run with `command = apply`.

```hcl
mock_provider "aws" {}

variables {
  bucket_prefix = "test"
}

run "bucket_name_has_prefix" {
  command = plan

  assert {
    condition     = startswith(aws_s3_bucket.this.bucket, "test-")
    error_message = "Bucket name must start with the prefix."
  }
}

run "uses_existing_vpc" {
  command = plan

  override_data {
    target = data.aws_vpc.selected
    values = { id = "vpc-00000000" }
  }

  assert {
    condition     = aws_subnet.this.vpc_id == "vpc-00000000"
    error_message = "Subnet must be placed in the selected VPC."
  }
}
```

- `mock_provider` needs no credentials and creates nothing: use it for logic (names, counts,
  conditions). `override_resource` and `override_data` replace one target, at file level or inside
  a `run`.
- A mocked test proves the configuration's logic, not that the cloud accepts it. Say which of the
  two a test covers.
- Variable precedence, lowest to highest: `TF_VAR_*`, tfvars files, `-var` / `-var-file`, the
  file's `variables` block, the run's `variables` block.
- Useful flags: `-filter=tests/x.tofutest.hcl`, `-test-directory=path`, `-verbose`, `-json`.
- An `apply` test that is interrupted can leave resources behind. Run those only in an account
  meant for tests, and tell the user what to look for if a run is cut short.

## Before any command that changes something

`tofu plan` is free to run. `tofu apply`, `tofu destroy`, `tofu state rm|mv`, `tofu import` and
`tofu force-unlock` change shared state or real infrastructure: show the plan and ask first.
