---
name: deploy-compose
description: Set up and validate the Docker Compose deployment for NanoClaw, OneCLI, and Postgres. Use when the user wants NanoClaw itself managed by Docker Compose instead of launchd or systemd.
---

# NanoClaw Docker Compose deployment

Set up the Compose deployment. Keep going until the stack is up and validated, unless the user needs to provide credentials or a path.

## Goal

Create a working Compose deployment based on:

- `docker-compose.yml`
- `Dockerfile.host`
- `.env.compose.template`
- host-path remapping via `NANOCLAW_HOST_PATH`
- a one-shot `agent-build` service

The runtime model must stay the same: NanoClaw runs as one long-lived service, agent invocations still happen as sibling `docker run` containers through the Docker socket.

## Step 1: Preflight

Run:

```bash
git status --porcelain
docker info
```

If the working tree is dirty, stop and tell the user to commit or stash first.

If Docker is unavailable, diagnose and fix it before continuing.

## Step 2: Required host values

You need these values before writing `.env.compose`:

- absolute repo checkout path for `NANOCLAW_HOST_PATH`
- docker socket group id for `DOCKER_GID`
- host config dir for `NANOCLAW_CONFIG_DIR`
- current build hash for `NANOCLAW_BUILD_HASH`

Detect them automatically when possible:

```bash
pwd
stat -f '%g' /var/run/docker.sock || stat -c '%g' /var/run/docker.sock
printf '%s\n' "$HOME/.config/nanoclaw"
git rev-parse HEAD
```

If any value cannot be determined automatically, ask the user for it.

## Step 3: Prepare host files

Ensure the external config directory exists and has placeholder files if missing:

```bash
mkdir -p "$HOME/.config/nanoclaw"
[ -f "$HOME/.config/nanoclaw/mount-allowlist.json" ] || printf '[]\n' > "$HOME/.config/nanoclaw/mount-allowlist.json"
[ -f "$HOME/.config/nanoclaw/sender-allowlist.json" ] || printf '{"allowed":[]}' > "$HOME/.config/nanoclaw/sender-allowlist.json"
mkdir -p /tmp/nanoclaw-shared
```

Do not overwrite real config files if they already exist.

## Step 4: Create `.env.compose`

Start from `.env.compose.template` and fill in:

- `NANOCLAW_HOST_PATH`
- `DOCKER_GID`
- `NANOCLAW_CONFIG_DIR`
- `NANOCLAW_SHARED_TMP`
- `NANOCLAW_DOCKER_NETWORK`
- `NANOCLAW_BUILD_HASH`

Leave OneCLI in local mode by default. Do not add `NEXTAUTH_SECRET` unless the user explicitly wants OAuth and also provides the matching Google OAuth values.

## Step 5: Start the stack

Run:

```bash
docker compose --env-file .env.compose up -d --build
```

The expected services are:

- `postgres`
- `onecli`
- `agent-build`
- `nanoclaw`

## Step 6: Validate

Run all of these and fix anything broken:

```bash
docker compose --env-file .env.compose ps
docker compose --env-file .env.compose logs --tail=200 nanoclaw onecli
docker compose --env-file .env.compose exec -T nanoclaw docker info
docker compose --env-file .env.compose exec -T nanoclaw printenv NANOCLAW_HOST_PATH
docker compose --env-file .env.compose exec -T nanoclaw printenv NANOCLAW_DOCKER_NETWORK
curl -I http://127.0.0.1:${COMPOSE_ONECLI_DASHBOARD_PORT:-10254}
```

Then verify sibling containers still work:

```bash
docker compose --env-file .env.compose exec -T nanoclaw sh -lc 'docker run --rm --network "$NANOCLAW_DOCKER_NETWORK" --entrypoint /bin/echo nanoclaw-agent:latest child-container-ok'
docker compose --env-file .env.compose exec -T nanoclaw sh -lc 'docker run --rm --network "$NANOCLAW_DOCKER_NETWORK" --entrypoint /bin/sh -v "$NANOCLAW_HOST_PATH":/mnt:ro nanoclaw-agent:latest -lc "test -f /mnt/package.json && echo bind-mount-ok"'
```

## Step 7: Report

Tell the user exactly what was created or updated, what validation passed, and any remaining manual steps such as channel credentials.

If the stack is healthy, point them at `docs/docker-compose-deployment.md` for the operator flow.
