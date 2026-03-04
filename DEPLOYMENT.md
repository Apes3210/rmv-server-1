# Deployment

⚠️ **IMPORTANT: DO NOT COMMIT OR PUSH THIS FILE TO GITHUB** ⚠️

This file contains VPS credentials and sensitive deployment information. Keep it local only.

This project uses **blue-green deployment** with Docker Compose profiles and nginx upstream switching for zero-downtime deploys.

## Architecture

- Two sets of containers (blue/green) per service
- Nginx routes traffic to the active color
- Deploy script builds the inactive color, health-checks it, then switches nginx
- Old color is stopped only after traffic is routed to the new one

## Trigger

Push to `main` triggers GitHub Actions CI/CD automatically.

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
| Host     | `188.166.177.69`         |
| User     | `root`                   |
| Password | `Qqu9pR96:Pvh&E`         |

### Quick SSH via ops-tools

```powershell
$env:VPS_HOST="188.166.177.69"; $env:VPS_USER="root"; $env:VPS_PASSWORD="Qqu9pR96:Pvh&E"
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
