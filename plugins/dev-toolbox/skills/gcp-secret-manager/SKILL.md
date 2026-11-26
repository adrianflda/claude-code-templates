---
name: gcp-secret-manager
description: Storing and reading secrets with Google Cloud Secret Manager (access control, versions, rotation, how a workload consumes a secret). Use when code or infrastructure on Google Cloud creates, reads or rotates a secret.
disable-model-invocation: true
---

# Secret Manager

Read from Google's Secret Manager best practices page on 2026-11-25. Role names, flags and quotas
are not on that page: look them up before writing them
(https://docs.cloud.google.com/secret-manager/docs).

## Rules

- **Never print a secret value.** Not in a command's output, a log, a commit, a test fixture or a
  message to the user. Reading a version is a command the user runs or confirms.
- **Least privilege, per secret.** Bind access on the secret, not on the project, when several
  services share a project. Use IAM Conditions for narrower or time-limited access.
- **Separate projects per environment.** Staging and production secrets in different projects
  isolate the IAM bindings and the quotas.
- **No exported service account keys.** Locally `gcloud auth application-default login`; on
  Compute Engine and Cloud Run the metadata server; on GKE Workload Identity; outside Google Cloud
  workload identity federation.
- **Pin the version.** Reference a version number, not `latest`, and read it at startup. A new
  version goes out through the normal release, so it can be checked and rolled back.
- **Prefer the API.** Read the secret with the client library. A file can leak through a path
  traversal bug and an environment variable through a debug endpoint or a dependency that logs
  the environment. Serverless integrations may require one of the two: follow that product's page.
- **Disable before destroying.** Disabling a version is reversible. Wait about a week with it
  disabled before destroying it or deleting the secret.
- **No expiration on a production secret** unless permanent deletion is intended.
- **Rotate on a schedule**, and when someone who could read the secret leaves.
- **Automatic replication** unless there is a location requirement; then a regional secret or the
  `constraints/gcp.resourceLocations` policy.
- **Turn on data access logs** at folder or organization level, so every `AccessSecretVersion`
  call is recorded.
- **Count the reads.** Many instances starting at once all read their secrets: check the quota
  against that peak.

## When syncing to another store

A secret copied into Kubernetes Secrets or a CI variable is only as protected as that store.
Check who can read it there, whether reads are logged, and where it is kept.

## Before a command that changes something

Adding a version, disabling, destroying, deleting or changing an IAM binding affects running
workloads: show the command and ask first.
