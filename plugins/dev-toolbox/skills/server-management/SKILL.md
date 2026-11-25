---
name: server-management
description: Server management principles and decision-making. Process management, monitoring strategy, and scaling decisions. Teaches thinking, not commands.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
---

# Server Management

Decision points for running services in production. Prefer the project's existing tooling and runbooks over these defaults.

## Process management

| Scenario | Default choice |
|----------|----------------|
| Single Linux host, any app | systemd (restart on crash, survives reboot) |
| Node.js app needing clustering / zero-downtime reload without containers | PM2 |
| Containers | Docker/Podman with a restart policy |
| Multi-host orchestration | Kubernetes (or the platform's managed equivalent) |

Run services as a non-root user, with auto-restart configured rather than manual restarts.

## Monitoring and logs

- Cover availability (health checks), latency/throughput, error rate, and resources (CPU, memory, disk); alert on symptoms users feel, not on every metric.
- Structured (JSON) logs with levels, rotation configured, and no secrets or personal data in log lines.

## Scaling

| Symptom | First move |
|---------|------------|
| Slow responses | Profile before scaling |
| High memory | Check for a leak before adding RAM |
| Sustained high CPU | Scale horizontally if the app is stateless; vertically as a quick fix |
| Spiky traffic | Auto-scaling on a metric that leads the load |

## Health checks

Liveness: cheap, returns 200 if the process can serve. Readiness/deep: also checks the database and critical dependencies. Don't point a liveness probe at a deep check, or one slow dependency restarts every instance.

## Security baseline

SSH keys only, least-open firewall, regular patching, secrets from a secrets manager or runtime-injected environment (never in the repo or image), and an audit trail of access and changes.

## Troubleshooting order

Is it running → what do the logs say → resources (disk, memory, CPU) → network (ports, DNS) → dependencies (database, external APIs).
