@echo off
echo Starting Sitemap Migration Health Checker...
docker compose up -d
echo.
echo Tool is ready. Opening browser...
timeout /t 15
start http://localhost:3010