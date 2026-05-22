#!/usr/bin/env bash

# Colors for terminal output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Set Terminal Title
printf "\033]0;AirShare - Gesture File Transfer\007"

clear

echo -e "${CYAN}================================================${NC}"
echo -e "${CYAN}     _    _      _____ _                        ${NC}"
echo -e "${CYAN}    / \  (_)_ __|  ___| |__   __ _ _ __ ___     ${NC}"
echo -e "${CYAN}   / _ \ | | '__| |_  | '_ \ / _\` | '__/ _ \    ${NC}"
echo -e "${CYAN}  / ___ \| | |  |  _| | | | | (_| | | |  __/    ${NC}"
echo -e "${CYAN} /_/   \_\_|_|  |_|   |_| |_|\__,_|_|  \___|    ${NC}"
echo
echo -e "${CYAN}  Gesture-Based Cross-Device File Transfer      ${NC}"
echo -e "${CYAN}================================================${NC}"
echo

# ─── Check Python ─────────────────────────────
echo -e "${BLUE}[1/4] Checking Python...${NC}"
PYTHON_CMD=""
if command -v python3 >/dev/null 2>&1; then
    PYTHON_CMD="python3"
elif command -v python >/dev/null 2>&1; then
    PYTHON_CMD="python"
fi

if [ -z "$PYTHON_CMD" ]; then
    echo -e "${RED}[ERROR] Python is not installed or not in PATH!${NC}"
    echo -e "Please install Python 3 from https://www.python.org/downloads/"
    exit 1
fi

PYTHON_VERSION=$($PYTHON_CMD --version 2>&1)
echo -e "        Found: ${GREEN}$PYTHON_VERSION${NC}"

# ─── Check MongoDB ────────────────────────────
echo -e "${BLUE}[2/4] Checking MongoDB...${NC}"

# Check if MongoDB is already running
if pgrep -x "mongod" >/dev/null 2>&1; then
    echo -e "        MongoDB is already running."
else
    # Try starting MongoDB service or running in-memory
    if command -v brew >/dev/null 2>&1 && brew services list 2>&1 | grep -q "mongodb-community"; then
        echo -e "        Starting MongoDB via Homebrew..."
        brew services start mongodb-community >/dev/null 2>&1
        sleep 2
        if pgrep -x "mongod" >/dev/null 2>&1; then
            echo -e "        MongoDB started successfully."
        else
            echo -e "${YELLOW}[WARNING] Failed to start MongoDB via Homebrew.${NC}"
            echo -e "                  App will fall back to in-memory storage."
        fi
    elif command -v mongod >/dev/null 2>&1; then
        echo -e "        Starting MongoDB manually in background..."
        mkdir -p "$HOME/data/db"
        mongod --dbpath "$HOME/data/db" >/dev/null 2>&1 &
        sleep 3
        if pgrep -x "mongod" >/dev/null 2>&1; then
            echo -e "        MongoDB started manually."
        else
            echo -e "${YELLOW}[WARNING] Failed to start mongod process.${NC}"
            echo -e "                  App will fall back to in-memory storage."
        fi
    else
        echo -e "${YELLOW}[WARNING] MongoDB not found in PATH!${NC}"
        echo -e "                  App will run smoothly using the built-in"
        echo -e "                  in-memory storage fallback."
        echo -e "                  Install from: https://www.mongodb.com/try/download/community"
    fi
fi

# ─── Install Python Dependencies ──────────────
echo -e "${BLUE}[3/4] Checking dependencies...${NC}"

# Check if we are inside a virtual environment, if not we can install packages locally
# We will use pip3 or pip depending on what is linked to our python version
PIP_CMD=""
if command -v pip3 >/dev/null 2>&1; then
    PIP_CMD="pip3"
elif command -v pip >/dev/null 2>&1; then
    PIP_CMD="pip"
fi

if [ -z "$PIP_CMD" ]; then
    echo -e "${RED}[ERROR] pip/pip3 not found! Please install pip.${NC}"
    exit 1
fi

# Check if required packages are already importable
$PYTHON_CMD -c "import flask, flask_socketio, eventlet, pymongo, qrcode, PIL" >/dev/null 2>&1
if [ $? -ne 0 ]; then
    echo -e "        Installing missing dependencies from requirements.txt..."
    # Using --break-system-packages or normal install
    # Newer pip might complain about system-managed environments. We try installing normally first, if it fails we check for virtual environment or suggest pip install.
    # We can also add --break-system-packages if pip demands it for global environment.
    if ! $PIP_CMD install -r requirements.txt >/dev/null 2>&1; then
        echo -e "        Retrying with --break-system-packages..."
        $PIP_CMD install -r requirements.txt --break-system-packages >/dev/null 2>&1
    fi
    
    # Double check if successfully installed
    $PYTHON_CMD -c "import flask, flask_socketio, eventlet, pymongo, qrcode, PIL" >/dev/null 2>&1
    if [ $? -eq 0 ]; then
        echo -e "        Dependencies successfully installed."
    else
        echo -e "${RED}[ERROR] Failed to install all dependencies.${NC}"
        echo -e "Please run: pip install -r requirements.txt manually."
        exit 1
    fi
else
    echo -e "        All dependencies found."
fi

# ─── Start AirShare Server ────────────────────
echo -e "${BLUE}[4/4] Starting AirShare server...${NC}"
echo
echo -e "${CYAN}================================================${NC}"
echo -e "  AirShare is launching..."
echo -e "  Opening browser in 3 seconds..."
echo -e "${CYAN}================================================${NC}"
echo

# Detect OS and open browser in background
OS_TYPE="$(uname)"
PROTOCOL="http"
if [ -f "certs/cert.pem" ] && [ -f "certs/key.pem" ]; then
    PROTOCOL="https"
fi

(
    sleep 3
    if [[ "$OS_TYPE" == "Darwin" ]]; then
        open "${PROTOCOL}://localhost:5003"
    elif [[ "$OS_TYPE" == "Linux" ]]; then
        xdg-open "${PROTOCOL}://localhost:5003" || sensible-browser "${PROTOCOL}://localhost:5003" || x-www-browser "${PROTOCOL}://localhost:5003"
    fi
) >/dev/null 2>&1 &

# Change to the directory of this script
cd "$(dirname "$0")"

# Execute flask server
$PYTHON_CMD app.py

# Cleanup when stopped
echo
echo -e "${CYAN}================================================${NC}"
echo -e "  AirShare server stopped."
echo -e "${CYAN}================================================${NC}"
