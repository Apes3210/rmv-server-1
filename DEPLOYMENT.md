# Deployment

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

Last verified: 2026-03-02
