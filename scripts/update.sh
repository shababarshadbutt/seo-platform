#!/bin/bash

echo "============================================"
echo "SEO Tool - Update & Cleanup"
echo "============================================"
echo

# Check Docker
if ! docker info >/dev/null 2>&1; then
    echo "Docker is not running."
    exit 1
fi

echo "Pulling latest images..."
docker compose pull || exit 1

echo
echo "Stopping current containers..."
docker compose down

echo
echo "Starting latest version..."
docker compose up -d

echo
echo "Removing old unused Docker images..."
docker image prune -af

echo
echo "Removing unused build cache..."
docker builder prune -af

echo
echo "Waiting for services..."
sleep 20

echo
echo "Opening SEO Tool..."

if command -v open >/dev/null 2>&1; then
    open http://localhost:3010
elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open http://localhost:3010
fi

echo
echo "============================================"
echo "Update Complete!"
echo "Old Docker images removed."
echo "Latest version is running."
echo "============================================"