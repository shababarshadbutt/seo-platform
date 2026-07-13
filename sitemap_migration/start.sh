#!/bin/bash
echo "Starting Sitemap Migration Health Checker..."
docker compose up -d
echo "Waiting for services to start..."
sleep 20
open http://localhost:3010