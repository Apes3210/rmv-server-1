#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# Blue-Green Deploy Script
# Usage: ./blue-green-deploy.sh [api|web|both]
# ═══════════════════════════════════════════════════════════════════

DEPLOY_DIR="/opt/rmv/rmv-server/deploy"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.prod.yml"
UPSTREAM_FILE="$DEPLOY_DIR/nginx/upstream.conf"
COLOR_FILE="/opt/rmv/.active-color"

# ── Determine current and next color ─────────────────────────────
if [ -f "$COLOR_FILE" ]; then
  CURRENT=$(cat "$COLOR_FILE")
else
  CURRENT="none"
fi

if [ "$CURRENT" = "blue" ]; then
  NEXT="green"
else
  NEXT="blue"
fi

TARGET="${1:-both}"  # api, web, or both

echo "========== BLUE-GREEN DEPLOY =========="
echo "  Current active : $CURRENT"
echo "  Deploying to   : $NEXT"
echo "  Target services: $TARGET"
echo "========================================"

cd "$DEPLOY_DIR"

# ── Step 1: Build the NEXT color images ──────────────────────────
echo ""
echo "[1/5] Building $NEXT images..."
if [ "$TARGET" = "api" ] || [ "$TARGET" = "both" ]; then
  docker compose -f "$COMPOSE_FILE" --profile "$NEXT" build --no-cache "api-$NEXT"
  if [ $? -ne 0 ]; then
    echo "FATAL: api-$NEXT build failed"
    exit 1
  fi
fi

if [ "$TARGET" = "web" ] || [ "$TARGET" = "both" ]; then
  docker compose -f "$COMPOSE_FILE" --profile "$NEXT" build --no-cache "web-$NEXT"
  if [ $? -ne 0 ]; then
    echo "FATAL: web-$NEXT build failed"
    exit 1
  fi
fi
echo "Build complete."

# ── Step 2: Start the NEXT color containers ──────────────────────
echo ""
echo "[2/5] Starting $NEXT containers..."
docker compose -f "$COMPOSE_FILE" --profile "$NEXT" up -d
echo "Containers started."

# ── Step 3: Health check the NEXT color ──────────────────────────
echo ""
echo "[3/5] Health checking $NEXT containers..."

wait_healthy() {
  local container="$1"
  local max_attempts="${2:-60}"
  local i=1
  while [ "$i" -le "$max_attempts" ]; do
    local status
    status=$(docker inspect -f '{{.State.Health.Status}}' "$container" 2>/dev/null || echo "not-found")
    echo "  [$i/$max_attempts] $container -> $status"
    if [ "$status" = "healthy" ]; then
      return 0
    fi
    if [ "$status" = "unhealthy" ]; then
      echo "  FAILED: $container is unhealthy"
      docker logs --tail 20 "$container" 2>&1 || true
      return 1
    fi
    sleep 3
    i=$((i + 1))
  done
  echo "  TIMEOUT: $container did not become healthy"
  docker logs --tail 20 "$container" 2>&1 || true
  return 1
}

HEALTH_OK=true

if [ "$TARGET" = "api" ] || [ "$TARGET" = "both" ]; then
  if ! wait_healthy "rmv-api-$NEXT" 60; then
    HEALTH_OK=false
  fi
fi

if [ "$TARGET" = "web" ] || [ "$TARGET" = "both" ]; then
  if ! wait_healthy "rmv-web-$NEXT" 40; then
    HEALTH_OK=false
  fi
fi

if [ "$HEALTH_OK" != "true" ]; then
  echo ""
  echo "ROLLBACK: Health check failed — stopping $NEXT, keeping $CURRENT active"
  docker compose -f "$COMPOSE_FILE" --profile "$NEXT" stop 2>/dev/null || true
  exit 1
fi

echo "All $NEXT containers healthy!"

# ── Step 4: Switch nginx upstream (THE ZERO-DOWNTIME MOMENT) ────
echo ""
echo "[4/5] Switching nginx upstream to $NEXT..."

if [ "$TARGET" = "both" ]; then
  cat > "$UPSTREAM_FILE" <<EOF
# Active color: $NEXT (switched at $(date -u +%Y-%m-%dT%H:%M:%SZ))
upstream api_upstream {
  server api-$NEXT:5000;
}

upstream web_upstream {
  server web-$NEXT:80;
}
EOF
elif [ "$TARGET" = "api" ]; then
  WEB_COLOR="$CURRENT"
  if [ "$CURRENT" = "none" ]; then WEB_COLOR="$NEXT"; fi
  cat > "$UPSTREAM_FILE" <<EOF
# Active: api=$NEXT, web=$WEB_COLOR (switched at $(date -u +%Y-%m-%dT%H:%M:%SZ))
upstream api_upstream {
  server api-$NEXT:5000;
}

upstream web_upstream {
  server web-$WEB_COLOR:80;
}
EOF
elif [ "$TARGET" = "web" ]; then
  API_COLOR="$CURRENT"
  if [ "$CURRENT" = "none" ]; then API_COLOR="$NEXT"; fi
  cat > "$UPSTREAM_FILE" <<EOF
# Active: api=$API_COLOR, web=$NEXT (switched at $(date -u +%Y-%m-%dT%H:%M:%SZ))
upstream api_upstream {
  server api-$API_COLOR:5000;
}

upstream web_upstream {
  server web-$NEXT:80;
}
EOF
fi

# Reload nginx — this is the instant cutover, zero dropped requests
docker exec rmv-nginx nginx -t 2>&1
if [ $? -ne 0 ]; then
  echo "FATAL: nginx config test failed — rolling back upstream"
  if [ "$CURRENT" != "none" ]; then
    cat > "$UPSTREAM_FILE" <<EOF
# Active color: $CURRENT (rollback)
upstream api_upstream {
  server api-$CURRENT:5000;
}

upstream web_upstream {
  server web-$CURRENT:80;
}
EOF
  fi
  docker compose -f "$COMPOSE_FILE" --profile "$NEXT" stop 2>/dev/null || true
  exit 1
fi

docker exec rmv-nginx nginx -s reload
echo "Nginx reloaded — traffic now going to $NEXT!"

# ── Step 5: Stop old color + cleanup ─────────────────────────────
echo ""
echo "[5/5] Stopping old $CURRENT containers..."
if [ "$CURRENT" != "none" ]; then
  sleep 5  # Let in-flight requests finish
  docker compose -f "$COMPOSE_FILE" --profile "$CURRENT" stop 2>/dev/null || true
  docker compose -f "$COMPOSE_FILE" --profile "$CURRENT" rm -f 2>/dev/null || true
  echo "Old $CURRENT containers stopped."
else
  echo "No old containers to stop (first deploy)."
fi

# Save the new active color
echo "$NEXT" > "$COLOR_FILE"

# Prune old images
docker image prune -f 2>/dev/null || true

echo ""
echo "========== DEPLOY COMPLETE =========="
echo "  Active color: $NEXT"
echo "  $(docker ps --format 'table {{.Names}}\t{{.Status}}' | grep rmv)"
echo "====================================="
exit 0
