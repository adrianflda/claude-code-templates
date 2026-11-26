---
name: docker-expert
description: Dockerfile and Compose decisions (multi-stage builds, build cache, build secrets, non-root images, health checks, image size, local development with Compose). Use when writing, reviewing or debugging a Dockerfile or a compose file. Not for Kubernetes, CI pipelines or cloud container services.
---

# Docker

Written for this plugin from the official Docker documentation (docs.docker.com: "Building best
practices", "Build secrets", "Build cache", the Dockerfile reference and the Compose file
reference). Image tags and tool versions move: before pinning one, look it up (the `library-docs`
skill, library `/docker/docs`).

## Start from what the project has

1. Read the existing `Dockerfile*`, `compose*.y*ml` and `.dockerignore` before proposing anything.
   Keep the base image family, the stage names and the Compose layout unless one of them is the
   problem.
2. A project with no Dockerfile: `docker init` writes a Dockerfile, a `compose.yaml` and a
   `.dockerignore` for the detected stack. Start from its output and edit.
3. State which case this is: build is slow, image is large, container fails at start, container
   is unsafe, or services do not reach each other. Each has its own section below.

## Dockerfile

```dockerfile
# syntax=docker/dockerfile:1

FROM node:24-alpine AS base
WORKDIR /app

FROM base AS deps
# Bind mounts keep the manifests out of the layer; the cache mount keeps npm's download cache
# between builds without putting it in the image.
RUN --mount=type=bind,source=package.json,target=package.json \
    --mount=type=bind,source=package-lock.json,target=package-lock.json \
    --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

FROM base AS build
RUN --mount=type=bind,source=package.json,target=package.json \
    --mount=type=bind,source=package-lock.json,target=package-lock.json \
    --mount=type=cache,target=/root/.npm \
    npm ci
COPY . .
RUN npm run build

FROM base AS runtime
ENV NODE_ENV=production
# The official Node image ships an unprivileged user called node.
USER node
COPY --chown=node:node package.json .
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

Rules behind that file:

- **Order by how often things change.** Dependency manifests and the install step come before the
  source copy, so a source edit does not reinstall dependencies.
- **One stage per job.** Build tools and dev dependencies stay in the build stage; the final stage
  copies only what runs. `docker build --target build` gives a stage for tests or development.
- **`.dockerignore` is part of the Dockerfile.** At least `node_modules`, `.git`, build output,
  `.env*` and local secrets. A large build context is the usual cause of a slow "transferring
  context" step.
- **Exec-form `CMD`** (`["node", "dist/index.js"]`), not `npm start` and not the shell form: the
  process must be PID 1 to receive `SIGTERM` on stop. A process that does not reap children or
  handle signals gets `docker run --init` / `init: true` in Compose.
- **Pin the base image.** A tag is enough for most projects; pinning by digest
  (`FROM alpine:3.21@sha256:...`) guarantees the same image even if the tag moves, and also opts
  out of automatic security fixes, so pair it with a tool that updates the digest.
- **Run the build checks:** `docker build --check .` reports Dockerfile problems (for example a
  secret passed through `ARG` or `ENV`) without building.

### Build secrets

Never pass a credential through `ARG`, `ENV` or a `COPY`: it stays in the image history. Use a
secret mount, which exists only during that `RUN`:

```dockerfile
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc npm ci
# or as an environment variable for that one command
RUN --mount=type=secret,id=aws_key_id,env=AWS_ACCESS_KEY_ID \
    --mount=type=secret,id=aws_secret_key,env=AWS_SECRET_ACCESS_KEY \
    aws s3 cp s3://my-bucket/file .
```

```bash
docker build --secret id=npmrc,src=$HOME/.npmrc .
```

For a private Git repository over SSH use `--mount=type=ssh` with `docker build --ssh default`.

### Smaller and safer final images

| Choice | When |
|---|---|
| `-alpine` or `-slim` tag of the official image | default; has a shell and a package manager for debugging |
| Distroless (`gcr.io/distroless/nodejs24-debian13:nonroot`) | production image with no shell and no package manager; the entrypoint is already `node`, so `CMD ["dist/index.js"]` |
| Docker Hardened Images (`dhi.io/...`) | when the organization uses them; a `-dev` variant builds, the plain variant runs |
| `scratch` | a single static binary (Go, Rust) |

- The final stage runs as a non-root user: `USER node`, the `:nonroot` distroless tag, or a user
  created with a fixed UID. Check with `docker run --rm IMAGE id`.
- An image without `curl` cannot use a `curl` health check. Use the runtime itself:

  ```dockerfile
  HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "-e", "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
  ```

  In a distroless image the binary is `/nodejs/bin/node` and only the exec form works.
- Scan what was built: `docker scout quickview IMAGE`, then `docker scout cves IMAGE`.
- At run time, drop what the process does not need: `--read-only` with a `tmpfs` for scratch
  space, `--cap-drop=ALL`, `--security-opt no-new-privileges`, and memory and CPU limits.

## Compose

The file is `compose.yaml`; the top-level `version:` key is obsolete and should be removed.

```yaml
services:
  app:
    build:
      context: .
      target: runtime
    ports:
      - "3000:3000"
    environment:
      DATABASE_HOST: db
      DATABASE_PASSWORD_FILE: /run/secrets/db-password
    secrets:
      - db-password
    depends_on:
      db:
        condition: service_healthy
    init: true
    read_only: true
    tmpfs:
      - /tmp
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    restart: unless-stopped
    deploy:
      resources:
        limits:
          cpus: "1.0"
          memory: 512M

  db:
    image: postgres:18
    environment:
      POSTGRES_PASSWORD_FILE: /run/secrets/db-password
    secrets:
      - db-password
    volumes:
      # postgres 18 and later keep data under /var/lib/postgresql; 17 and earlier use
      # /var/lib/postgresql/data. Check the image's documentation before changing versions.
      - db-data:/var/lib/postgresql
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "postgres"]
      interval: 10s
      timeout: 5s
      retries: 5
    expose:
      - "5432"

volumes:
  db-data:

secrets:
  db-password:
    file: ./secrets/db-password.txt
```

- **Start order is `depends_on` plus a health check.** `condition: service_healthy` waits for the
  dependency's `healthcheck`; a bare `depends_on` waits only for the container to start.
  `service_completed_successfully` is for one-shot jobs such as migrations.
- **Secrets are files under `/run/secrets/`**, not environment variables in the compose file. Keep
  the secret file out of Git and out of the build context.
- **Services reach each other by service name** on the project's default network. Publish
  (`ports:`) only what the host must reach; `expose:` documents a port for other services. Put a
  database on a network marked `internal: true` when nothing outside should reach it.
- **Named volumes for data, bind mounts for source code in development.** Never a bind mount for a
  production database.
- **Per-environment differences go in a second file** (`compose.override.yaml` is merged
  automatically; `-f compose.yaml -f compose.prod.yaml` otherwise) or in `profiles:`, not in
  copies of the whole file.
- Validate with `docker compose config`: it prints the merged file or the error.

### Local development: watch instead of bind-mount tricks

```yaml
services:
  app:
    build:
      context: .
      target: build
    command: npm run dev
    develop:
      watch:
        - action: sync
          path: ./src
          target: /app/src
          ignore:
            - node_modules/
        - action: rebuild
          path: package.json
```

`docker compose up --watch` copies changed files into the container (`sync`), restarts it after a
copy (`sync+restart`) or rebuilds the image (`rebuild`). It replaces the anonymous-volume trick
for `node_modules`.

## Diagnosing

| Symptom | Look at | Usual cause |
|---|---|---|
| Every build reinstalls dependencies | which step first shows no `CACHED` | source copied before the install step; no `.dockerignore`, so any file change invalidates `COPY . .` |
| Slow build in CI only | builder cache | no cache between runs: export it (`--cache-to` / `--cache-from` with `type=gha` or `type=registry`) |
| Image is large | `docker history IMAGE`, `docker image ls` | single stage; dev dependencies or build tools in the final stage; package cache left in a layer |
| Container exits at once | `docker logs NAME`, `docker inspect --format '{{.State.ExitCode}}' NAME` | wrong `CMD` path after a multi-stage copy; file not readable by the non-root user |
| Stops only after 10 s | `docker stop` timing | shell-form `CMD` or `npm start`: the app never gets `SIGTERM` |
| Service cannot reach another | `docker compose ps`, `docker compose exec app getent hosts db` | using `localhost` instead of the service name; services on different networks; dependency not healthy yet |
| "exec format error" | `docker image inspect --format '{{.Architecture}}' IMAGE` | image built for another CPU: `docker buildx build --platform linux/amd64,linux/arm64 --push .` |
| Permission denied on a volume | `id` inside the container, owner of the mount | files owned by root, process runs as non-root: `COPY --chown`, or fix the volume's owner |

Run a command that changes state on the user's machine (`docker system prune`, removing volumes,
`docker compose down -v`) only when the user asked for it: volumes hold data.

## Review checklist

- [ ] Dependency install comes before the source copy; `.dockerignore` exists and excludes
      `.git`, dependencies, build output and env files
- [ ] Multi-stage; the final stage has no compiler, no dev dependencies, no package cache
- [ ] No credential in `ARG`, `ENV`, `COPY` or the compose file; build secrets use
      `--mount=type=secret`
- [ ] Final image runs as a non-root user and has a pinned base image
- [ ] `CMD` in exec form; the process handles `SIGTERM` or runs under an init
- [ ] A health check that works with the tools the image has
- [ ] Compose: `depends_on` with `condition: service_healthy`, secrets as files, named volumes for
      data, only the needed ports published, resource limits set
- [ ] `docker build --check .` and `docker compose config` pass

For Kubernetes, CI pipelines or cloud infrastructure beyond the container, say so and suggest the
devops-engineer agent.
