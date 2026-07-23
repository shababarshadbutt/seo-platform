@echo off
REM Sitemap Migration tool - start/stop helper for the SEO team.
REM Usage: start-stop.bat [start|stop]   (defaults to start)

setlocal
set "ACTION=%~1"
if "%ACTION%"=="" set "ACTION=start"

if /I "%ACTION%"=="stop" (
  echo Stopping Sitemap Migration tool...
  docker compose down
) else (
  echo Starting Sitemap Migration tool...
  docker compose up -d --build

  echo Waiting for services to start...
  timeout /t 8 /nobreak >nul

  REM Test connectivity from inside Docker so we catch a blocking corporate
  REM proxy/firewall before the user wastes a run on it. (v1.39 Fix 3)
  echo Testing network connectivity...
  docker compose exec -T worker node -e "const https=require('https');https.get('https://www.google.com',r=>{console.log('Network OK')}).on('error',e=>{console.log('WARNING: Network issue detected -',e.message)})"

  echo.
  echo If you saw a WARNING above, your network is blocking outbound HTTPS
  echo (usually a corporate SSL-inspection proxy). Add the line
  echo   NODE_TLS_REJECT_UNAUTHORIZED=0
  echo to your .env file, then re-run this script.
)

endlocal
