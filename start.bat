@echo off
title AirShare - Gesture File Transfer
color 0B
cls

echo.
echo  ================================================
echo       _    _      _____ _                     
echo     / \  (_)_ __^|  ___^| ^|__   __ _ _ __ ___ 
echo    / _ \ ^| ^| '__^| ^|_  ^| '_ \ / _` ^| '__/ _ \
echo   / ___ \^| ^| ^|  ^|  _^| ^| ^| ^| ^| (_^| ^| ^| ^|  __/
echo  /_/   \_\_^|_^|  ^|_^|   ^|_^| ^|_^|\__,_^|_^|  \___^|
echo.
echo   Gesture-Based Cross-Device File Transfer
echo  ================================================
echo.

:: ─── Check Python ─────────────────────────────
echo  [1/4] Checking Python...
python --version >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] Python is not installed or not in PATH!
    echo  Download from: https://www.python.org/downloads/
    pause
    exit /b 1
)
for /f "tokens=*" %%i in ('python --version 2^>^&1') do echo         Found: %%i

:: ─── Check MongoDB ────────────────────────────
echo  [2/4] Checking MongoDB...

:: Check if MongoDB is running as a Windows service
sc query MongoDB >nul 2>&1
if errorlevel 1 (
    echo         MongoDB service not found. Trying to start manually...
    goto :start_mongo_manual
)

:: Service exists, check if running
for /f "tokens=3 delims=: " %%a in ('sc query MongoDB ^| findstr "STATE"') do set MONGO_STATE=%%a
if "%MONGO_STATE%"=="4" (
    echo         MongoDB service is running.
    goto :mongo_ready
)

echo         Starting MongoDB service...
net start MongoDB >nul 2>&1
if errorlevel 1 (
    echo         Could not start service. Trying manual start...
    goto :start_mongo_manual
)
echo         MongoDB service started.
goto :mongo_ready

:start_mongo_manual
:: Try to start mongod manually
set MONGOD_PATH=C:\Program Files\MongoDB\Server\8.2\bin\mongod.exe
if not exist "%MONGOD_PATH%" (
    set MONGOD_PATH=C:\Program Files\MongoDB\Server\7.0\bin\mongod.exe
)
if not exist "%MONGOD_PATH%" (
    set MONGOD_PATH=C:\Program Files\MongoDB\Server\6.0\bin\mongod.exe
)
if not exist "%MONGOD_PATH%" (
    echo  [WARNING] MongoDB not found! App will run without database.
    echo            Install from: https://www.mongodb.com/try/download/community
    goto :skip_mongo
)

:: Create data directory if needed
if not exist "C:\data\db" mkdir "C:\data\db"

echo         Starting MongoDB manually...
start "MongoDB" /min "%MONGOD_PATH%" --dbpath "C:\data\db"
timeout /t 3 /nobreak >nul
echo         MongoDB started manually.

:mongo_ready
echo         MongoDB is ready.

:skip_mongo

:: ─── Install Python Dependencies ──────────────
echo  [3/4] Checking dependencies...
pip show flask >nul 2>&1
if errorlevel 1 (
    echo         Installing dependencies...
    pip install flask flask-socketio eventlet pymongo qrcode pillow >nul 2>&1
    echo         Dependencies installed.
) else (
    echo         All dependencies found.
)

:: ─── Start AirShare Server ────────────────────
echo  [4/4] Starting AirShare server...
echo.
echo  ================================================
echo   AirShare is launching...
echo   Opening browser in 3 seconds...
echo  ================================================
echo.

:: Start browser after a delay
start "" cmd /c "timeout /t 3 /nobreak >nul && start http://localhost:5000"

:: Start the Flask server (this blocks until Ctrl+C)
cd /d "%~dp0"
python app.py

:: Cleanup message when server stops
echo.
echo  ================================================
echo   AirShare server stopped.
echo  ================================================
pause
