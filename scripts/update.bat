@echo off
setlocal

echo ============================================
echo SEO Tool - Update & Cleanup
echo ============================================
echo.

REM Check Docker
docker info >nul 2>&1
if %errorlevel% neq 0 (
    echo Docker Desktop is not running.
    pause
    exit /b 1
)

echo Pulling latest images...
docker compose pull

if %errorlevel% neq 0 (
    echo Failed to pull latest images.
    pause
    exit /b 1
)

echo.
echo Stopping current containers...
docker compose down

echo.
echo Starting latest version...
docker compose up -d

echo.
echo Removing old unused Docker images...
docker image prune -af

echo.
echo Removing unused build cache...
docker builder prune -af

echo.
echo Waiting for services...
timeout /t 20 /nobreak >nul

echo.
echo Opening SEO Tool...
start http://localhost:3010

echo.
echo ============================================
echo Update Complete!
echo Old Docker images removed.
echo Latest version is running.
echo ============================================

pause