# Docker Compose deployment

This deployment path keeps NanoClaw's runtime model intact:

- `nanoclaw` is the long-running Node.js orchestrator
- `postgres` backs OneCLI state
- `onecli` is the credential gateway and dashboard
- `agent-build` builds the `nanoclaw-agent` image before NanoClaw starts
- agent runs still happen as ephemeral sibling `docker run` containers launched by NanoClaw itself

The important difference from the earlier same-path prototype is that the host process now runs at `/app` inside the container while agent containers still need host-visible bind mounts. `src/container-runner.ts` now remaps repo-local paths back to the host checkout with `NANOCLAW_HOST_PATH` before it launches sibling agent containers.

## What this gets you

This Compose path is for running the whole outer NanoClaw system under Docker instead of using `/setup` with launchd or systemd. When it is up, you get:

- NanoClaw running as a long-lived service in Docker
- OneCLI running beside it in local mode by default
- Postgres backing OneCLI state
- a one-shot agent image build wired into Compose startup
- NanoClaw still launching isolated `nanoclaw-agent` containers for actual agent work

## Prerequisites

You need:

- Docker Engine with `docker compose`
- a local NanoClaw checkout on the Docker host
- a normal NanoClaw `.env` file in the repo for NanoClaw's own host-side config and channel bootstrap values
- a host config directory for NanoClaw at `~/.config/nanoclaw/`

The repo's normal `.env` is still where NanoClaw reads settings like `THENVOI_*`, `TELEGRAM_*`, `SLACK_*`, `DISCORD_*`, `TZ`, and anything else loaded by `src/env.ts`. Compose does not replace that file.

## Start-to-finish setup

### 1. Clone the repo

```bash
git clone <your-fork-or-repo-url>
cd nanoclaw
```

### 2. Create NanoClaw's normal `.env`

Create the repo `.env` file the same way you normally would for NanoClaw. This file is still used by the `nanoclaw` service because NanoClaw reads it from disk.

At minimum, set whatever NanoClaw itself needs for the channels you want to run. For example, if you are using Thenvoi:

```bash
THENVOI_BASE_URL=https://app.thenvoi.com
THENVOI_AGENT_ID=...
THENVOI_API_KEY=...
TZ=America/Los_Angeles
```

### 3. Create the host config directory

NanoClaw expects these external config files outside the repo:

```bash
mkdir -p ~/.config/nanoclaw
[ -f ~/.config/nanoclaw/mount-allowlist.json ] || printf '[]\n' > ~/.config/nanoclaw/mount-allowlist.json
[ -f ~/.config/nanoclaw/sender-allowlist.json ] || printf '{"allowed":[]}' > ~/.config/nanoclaw/sender-allowlist.json
```

Adjust those files to match your real allowlists before using additional mounts or sender restrictions.

### 4. Create the Compose env file

Start from the checked-in template:

```bash
cp .env.compose.template .env.compose
```

Then edit `.env.compose`.

Required values:

- `NANOCLAW_HOST_PATH` must be the absolute path of this checkout on the host
- `DOCKER_GID` must match the group id of `/var/run/docker.sock`
- the `nanoclaw` service currently runs as root inside the host container so it can use the Docker socket reliably across hosts; agent containers still run with their normal per-invocation user handling
- `NANOCLAW_CONFIG_DIR` must point at your host NanoClaw config dir
- `NANOCLAW_BUILD_HASH` should be set to the current commit hash

Typical local example:

```bash
NANOCLAW_HOST_PATH=/absolute/path/to/nanoclaw
DOCKER_GID=0
NANOCLAW_CONFIG_DIR=/Users/you/.config/nanoclaw
NANOCLAW_SHARED_TMP=/tmp/nanoclaw-shared
NANOCLAW_DOCKER_NETWORK=nanoclaw-compose
NANOCLAW_BUILD_HASH=$(git rev-parse HEAD)
COMPOSE_CONTAINER_IMAGE=nanoclaw-agent:latest
COMPOSE_ONECLI_DASHBOARD_PORT=10254
COMPOSE_ONECLI_GATEWAY_PORT=10255
COMPOSE_POSTGRES_USER=onecli
COMPOSE_POSTGRES_PASSWORD=onecli
COMPOSE_POSTGRES_DB=onecli
```

If `10254` or `10255` are already in use on your machine, change the published ports.

### 5. Leave OneCLI in local mode unless you explicitly want OAuth

The default Compose path is designed to boot cleanly without extra auth setup.

Do not add `NEXTAUTH_SECRET` unless you are intentionally setting up Google OAuth too. If you set `NEXTAUTH_SECRET` by itself, OneCLI switches into OAuth mode and the dashboard redirects into its setup error flow.

If you later want OAuth, add all three together in a separate override file or deployment-specific env:

- `NEXTAUTH_SECRET`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`

### 6. Start the full stack

```bash
docker compose --env-file .env.compose up -d --build
```

This starts:

- `postgres`
- `onecli`
- `agent-build`
- `nanoclaw`

### 7. Confirm the services are up

```bash
docker compose --env-file .env.compose ps
```

You want to see:

- `postgres` healthy
- `onecli` healthy
- `agent-build` exited 0
- `nanoclaw` up

### 8. Confirm OneCLI is serving normally

Open the dashboard:

```bash
open http://127.0.0.1:10254
```

Or the remapped dashboard port if you changed it.

### 9. Confirm NanoClaw can still launch sibling agent containers

This is the critical runtime check.

First verify Docker access from inside the running `nanoclaw` service:

```bash
docker compose --env-file .env.compose exec -T nanoclaw docker info
```

Then verify the host-path remapping env is present:

```bash
docker compose --env-file .env.compose exec -T nanoclaw printenv NANOCLAW_HOST_PATH
```

That output must match the absolute host repo path from `.env.compose`.

Then verify the compose network wiring:

```bash
docker compose --env-file .env.compose exec -T nanoclaw printenv NANOCLAW_DOCKER_NETWORK
```

If you want to prove sibling agent launches work directly, run:

```bash
docker compose --env-file .env.compose exec -T nanoclaw sh -lc 'docker run --rm --network "$NANOCLAW_DOCKER_NETWORK" --entrypoint /bin/echo nanoclaw-agent:latest child-container-ok'
```

And for the bind-mount check using the host path mapping:

```bash
docker compose --env-file .env.compose exec -T nanoclaw sh -lc 'docker run --rm --network "$NANOCLAW_DOCKER_NETWORK" --entrypoint /bin/sh -v "$NANOCLAW_HOST_PATH":/mnt:ro nanoclaw-agent:latest -lc "test -f /mnt/package.json && echo bind-mount-ok"'
```

If both succeed, the Compose deployment is preserving NanoClaw's real execution model.

## Day-to-day operations

### Watch logs

```bash
docker compose --env-file .env.compose logs -f postgres onecli nanoclaw
```

### Rebuild NanoClaw after code changes

```bash
docker compose --env-file .env.compose build nanoclaw
docker compose --env-file .env.compose up -d nanoclaw
```

### Rebuild the inner agent runtime after `container/` changes

```bash
docker compose --env-file .env.compose run --rm agent-build
```

### Stop everything and remove Compose-managed state

```bash
docker compose --env-file .env.compose down -v --remove-orphans
```

## How secrets and env vars work here

Compose does not change NanoClaw's current split:

- the NanoClaw process inside the container still uses the repo `.env` for its own host-side config and channel bootstrap values
- the `nanoclaw` service gets `ONECLI_URL=http://onecli:10254` on the Compose network
- sibling agent containers get outbound credentials through OneCLI injection in `src/container-runner.ts`
- proxy env vars from OneCLI are rewritten from `host.docker.internal` to `onecli` when sibling containers are launched on the Compose network

For Thenvoi, the current behavior stays the same:

- the host process still needs `THENVOI_BASE_URL`, `THENVOI_AGENT_ID`, and `THENVOI_API_KEY` in the normal repo `.env`
- HTTPS agent traffic should use OneCLI secret injection
- local HTTP Thenvoi remains the exception where `THENVOI_API_KEY` is passed directly to child containers

## Troubleshooting

If `nanoclaw` starts but agent runs fail immediately, check these first:

1. `docker compose --env-file .env.compose exec nanoclaw docker info`
2. `docker compose --env-file .env.compose exec nanoclaw printenv NANOCLAW_HOST_PATH`
3. confirm `NANOCLAW_HOST_PATH` exactly matches the host repo checkout
4. confirm `docker compose --env-file .env.compose exec nanoclaw printenv NANOCLAW_DOCKER_NETWORK` matches the Compose network name
5. confirm `docker ps --filter label=nanoclaw.agent=true` shows only agent containers, never the Compose infrastructure
6. if the dashboard redirects into OAuth setup, remove `NEXTAUTH_SECRET` unless you also set the Google OAuth variables
7. if OneCLI exits immediately complaining about `DATABASE_URL`, the Postgres service or env values are wrong

If bind mounts fail inside agent containers, the first thing to verify is that `NANOCLAW_HOST_PATH` points at the host repo checkout and not the container path.

If `docker info` fails inside `nanoclaw`, the Docker socket mount is missing or Docker is not healthy on the host.
