#!/usr/bin/env bash
# Sitemap Migration tool - start/stop helper for the SEO team.
# Usage: ./start-stop.sh [start|stop]   (defaults to start)
set -euo pipefail

ACTION="${1:-start}"

if [ "$ACTION" = "stop" ]; then
  echo "Stopping Sitemap Migration tool..."
  docker compose down
  exit 0
fi

echo "Starting Sitemap Migration tool..."
docker compose up -d --build

echo "Waiting for services to start..."
sleep 8

# Test connectivity from inside Docker so we catch a blocking corporate
# proxy/firewall before the user wastes a run on it. (v1.39 Fix 3)
echo "Testing network connectivity..."
docker compose exec -T worker node -e "const https=require('https');https.get('https://www.google.com',r=>{console.log('Network OK')}).on('error',e=>{console.log('WARNING: Network issue -',e.message)})"

echo
echo "If you saw a WARNING above, your network is blocking outbound HTTPS"
echo "(usually a corporate SSL-inspection proxy). Add the line"
echo "  NODE_TLS_REJECT_UNAUTHORIZED=0"
echo "to your .env file, then re-run this script."
