# Deployment

This file intentionally documents the deployment flow without storing live credentials.
Keep hostnames, usernames, passwords, tokens, and private keys in environment variables or your secret manager, not in this repo.

This project uses **blue-green deployment** with Docker Compose profiles and nginx upstream switching for zero-downtime deploys.

## Architecture

- Two sets of containers (blue/green) per service
- Nginx routes traffic to the active color
- GitHub Actions builds and pushes fresh images on every push to `main`
- The VPS deploy script pulls the new image for the inactive color, health-checks it, then switches nginx
- Old color is stopped only after traffic is routed to the new one
- If image pull fails, the deploy script falls back to a local VPS build so blue-green deploys still work

## Trigger

Push to `main` triggers GitHub Actions CI/CD automatically.

## Required GitHub Secrets

| Secret          | Purpose |
|-----------------|---------|
| `VPS_HOST`      | SSH target host |
| `VPS_USERNAME`  | SSH username |
| `VPS_PASSWORD`  | SSH password |
| `GHCR_USERNAME` | GitHub Container Registry username for the VPS pull step |
| `GHCR_TOKEN`    | GitHub Container Registry token with at least `read:packages` |

`GHCR_USERNAME` and `GHCR_TOKEN` are strongly recommended so the VPS can pull the prebuilt images directly. If they are missing or the pull fails, the script falls back to building on the VPS, which is slower.

## Manual Deploy

```bash
cd /opt/rmv/rmv-server
./deploy/scripts/blue-green-deploy.sh api   # deploy backend
./deploy/scripts/blue-green-deploy.sh web   # deploy frontend
./deploy/scripts/blue-green-deploy.sh both  # deploy both
```

Last verified: 2026-03-04

## VPS Access

| Field    | Value                    |
|----------|--------------------------|
| Host     | `<set via secret>`       |
| User     | `<set via secret>`       |
| Password | `<set via secret>`       |

### Quick SSH via ops-tools

```powershell
$env:VPS_HOST="<set via secret>"; $env:VPS_USER="<set via secret>"; $env:VPS_PASSWORD="<set via secret>"
cd ops-tools
node run-ssh.mjs "<command>"
```

### Common Commands

```bash
# Check active color
cat /opt/rmv/.color-api   # or .color-web

# Restart active API (force-recreate to pick up .env changes)
cd /opt/rmv/rmv-server/deploy
docker compose -f docker-compose.prod.yml --profile green up -d --force-recreate api-green

# Check container health
docker exec rmv-api-green wget -qO- http://localhost:5000/api/v1/health

# View logs
docker logs rmv-api-green --tail 100 -f
```
