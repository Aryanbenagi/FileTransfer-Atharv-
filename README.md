# AirShare – Gesture-Based Cross-Device File Transfer

A futuristic, touchless file sharing system where users can **pick files using hand gestures**, move them in the air, and **throw them to another device** — all powered by webcam-based hand tracking.

## Features

- **✋ Hand Gesture Control** — Pinch to select, Fist to hold, Open/Throw to send
- **📡 Cross-Device Transfer** — Share files between any devices on the same WiFi
- **📋 Air Clipboard** — Copy-paste text across devices instantly
- **👥 Group Share** — Broadcast files to all connected devices
- **📊 MongoDB Dashboard** — Transfer history, stats, device registry
- **📱 QR Code Connect** — Scan to connect your phone instantly

## Tech Stack

- **Backend**: Python (Flask + Flask-SocketIO + Eventlet)
- **Frontend**: Vanilla JS, MediaPipe Hands (hand tracking)
- **Database**: MongoDB (local)
- **Real-time**: WebSocket via Socket.IO

## Quick Start

### Option 1: macOS / Linux (One-click)
Run the startup script in terminal:
```bash
./start.sh
```

### Option 2: Windows (One-click)
Double-click `start.bat` or run:
```cmd
start.bat
```

### Option 3: Manual (Cross-platform)
```bash
pip install -r requirements.txt
python3 app.py
```


## How to Connect Other Devices

1. Both devices must be on the **same WiFi network**
2. Click **"+ Connect Devices"** in the app to see your network URL
3. Open that URL on the other device's browser
4. The device appears automatically in the **Nearby Devices** panel

## Gestures

| Gesture | Action |
|---------|--------|
| 🤏 Pinch | Select / Pick file |
| ✊ Fist | Hold file |
| 🖐️ Open Hand | Release / Drop |
| 🫳 Throw | Send to target device |
| ☝️ Point | Navigate |

## Project Structure

```
├── app.py              # Flask server + MongoDB + SocketIO
├── start.bat           # One-click launcher (Windows)
├── start.sh            # One-click launcher (macOS/Linux)
├── templates/
│   └── index.html      # Main UI template
├── static/
│   ├── css/style.css   # Cyberpunk UI styles
│   └── js/
│       ├── app.js      # Main app logic
│       ├── gesture.js  # MediaPipe gesture engine
│       ├── transfer.js # File transfer via chunks
│       ├── ui.js       # UI controller
│       └── particles.js# Background particle system
└── shared_files/       # Uploaded files directory
```

## License

Private repository.
