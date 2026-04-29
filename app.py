"""
AirShare - Gesture-Based Cross-Device File Transfer System
Main Flask + SocketIO Server with MongoDB Integration
"""

import os
import uuid
import socket
import json
import time
import io
import base64
from datetime import datetime
from flask import Flask, render_template, request, send_from_directory, jsonify, Response
from flask_socketio import SocketIO, emit
from pymongo import MongoClient
from pymongo.errors import ConnectionFailure
import qrcode

app = Flask(__name__, static_folder='static', template_folder='templates')
app.config['SECRET_KEY'] = 'airshare-secret-key-2024'
app.config['MAX_CONTENT_LENGTH'] = 500 * 1024 * 1024

socketio = SocketIO(app, cors_allowed_origins="*", max_http_buffer_size=100 * 1024 * 1024)

# ─── MongoDB Setup ─────────────────────────────────────────
MONGO_URI = os.environ.get('MONGO_URI', 'mongodb://localhost:27017/')
DB_NAME = 'airshare'

try:
    mongo_client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=3000)
    mongo_client.admin.command('ping')
    db = mongo_client[DB_NAME]
    print('[MongoDB] Connected successfully')
    mongo_connected = True
except ConnectionFailure:
    print('[MongoDB] WARNING: Could not connect. Running without database.')
    db = None
    mongo_connected = False

# Collections (created lazily by MongoDB)
# db.devices        - registered device profiles
# db.transfers      - file transfer history
# db.clipboard      - air clipboard history
# db.settings       - user/device settings


def get_col(name):
    """Safely get a collection, returns None if no DB."""
    return db[name] if db is not None else None


# ─── In-memory connected devices (live sessions) ──────────
devices = {}

UPLOAD_FOLDER = os.path.join(os.path.dirname(__file__), 'shared_files')
os.makedirs(UPLOAD_FOLDER, exist_ok=True)


def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


# ─── REST API Routes ──────────────────────────────────────

@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/connection-info')
def connection_info():
    """Return the server's network URL for other devices to connect."""
    local_ip = get_local_ip()
    port = 5000
    url = f'http://{local_ip}:{port}'
    return jsonify({
        'url': url,
        'ip': local_ip,
        'port': port,
        'activeDevices': len(devices)
    })


@app.route('/api/qr')
def qr_code():
    """Generate a QR code PNG for the server URL."""
    local_ip = get_local_ip()
    port = 5000
    url = f'http://{local_ip}:{port}'
    qr = qrcode.QRCode(version=1, box_size=8, border=2)
    qr.add_data(url)
    qr.make(fit=True)
    img = qr.make_image(fill_color='#6366f1', back_color='#0a0a1a')
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    buf.seek(0)
    return Response(buf.getvalue(), mimetype='image/png')


@app.route('/api/transfers', methods=['GET'])
def get_transfers():
    """Get transfer history from MongoDB."""
    col = get_col('transfers')
    if col is None:
        return jsonify({'transfers': [], 'dbConnected': False})
    transfers = list(col.find({}, {'_id': 0}).sort('timestamp', -1).limit(50))
    return jsonify({'transfers': transfers, 'dbConnected': True})


@app.route('/api/transfers/clear', methods=['POST'])
def clear_transfers():
    col = get_col('transfers')
    if col is not None:
        col.delete_many({})
    return jsonify({'status': 'ok'})


@app.route('/api/clipboard', methods=['GET'])
def get_clipboard_history():
    col = get_col('clipboard')
    if col is None:
        return jsonify({'items': [], 'dbConnected': False})
    items = list(col.find({}, {'_id': 0}).sort('timestamp', -1).limit(20))
    return jsonify({'items': items, 'dbConnected': True})


@app.route('/api/clipboard/clear', methods=['POST'])
def clear_clipboard():
    col = get_col('clipboard')
    if col is not None:
        col.delete_many({})
    return jsonify({'status': 'ok'})


@app.route('/api/settings/<device_id>', methods=['GET'])
def get_settings(device_id):
    col = get_col('settings')
    if col is None:
        return jsonify({'settings': None, 'dbConnected': False})
    settings = col.find_one({'deviceId': device_id}, {'_id': 0})
    return jsonify({'settings': settings, 'dbConnected': True})


@app.route('/api/settings/<device_id>', methods=['POST'])
def save_settings(device_id):
    col = get_col('settings')
    if col is None:
        return jsonify({'status': 'no_db'})
    data = request.get_json()
    col.update_one(
        {'deviceId': device_id},
        {'$set': {**data, 'deviceId': device_id, 'updatedAt': datetime.now().isoformat()}},
        upsert=True
    )
    return jsonify({'status': 'ok'})


@app.route('/api/stats', methods=['GET'])
def get_stats():
    """Dashboard stats from MongoDB."""
    if db is None:
        return jsonify({'dbConnected': False})

    transfer_col = get_col('transfers')
    clip_col = get_col('clipboard')
    device_col = get_col('devices')

    total_transfers = transfer_col.count_documents({}) if transfer_col is not None else 0
    total_bytes = 0
    if transfer_col is not None:
        pipeline = [{'$group': {'_id': None, 'total': {'$sum': '$fileSize'}}}]
        result = list(transfer_col.aggregate(pipeline))
        total_bytes = result[0]['total'] if result else 0

    total_clips = clip_col.count_documents({}) if clip_col is not None else 0
    total_devices = device_col.count_documents({}) if device_col is not None else 0

    return jsonify({
        'dbConnected': True,
        'totalTransfers': total_transfers,
        'totalBytes': total_bytes,
        'totalClipboards': total_clips,
        'totalDevices': total_devices,
        'activeDevices': len(devices)
    })


@app.route('/shared_files/<path:filename>')
def download_file(filename):
    return send_from_directory(UPLOAD_FOLDER, filename, as_attachment=True)


# ─── MongoDB Helper Functions ─────────────────────────────

def log_transfer(sender_id, sender_name, receiver_id, file_name, file_size, gesture_type, status='completed'):
    col = get_col('transfers')
    if col is None:
        return
    col.insert_one({
        'senderId': sender_id,
        'senderName': sender_name,
        'receiverId': receiver_id,
        'fileName': file_name,
        'fileSize': file_size,
        'gestureType': gesture_type,
        'status': status,
        'timestamp': datetime.now().isoformat()
    })


def log_clipboard(sender_id, sender_name, target_id, content, content_type='text'):
    col = get_col('clipboard')
    if col is None:
        return
    col.insert_one({
        'senderId': sender_id,
        'senderName': sender_name,
        'targetId': target_id,
        'content': content[:500],  # limit stored content
        'contentType': content_type,
        'timestamp': datetime.now().isoformat()
    })


def register_device_db(device_id, name, device_type):
    col = get_col('devices')
    if col is None:
        return
    col.update_one(
        {'deviceId': device_id},
        {'$set': {
            'deviceId': device_id,
            'name': name,
            'type': device_type,
            'lastSeen': datetime.now().isoformat()
        }, '$inc': {'connectionCount': 1}},
        upsert=True
    )


# ─── SocketIO Events ─────────────────────────────────────

@socketio.on('connect')
def handle_connect():
    device_id = str(uuid.uuid4())[:8]
    devices[request.sid] = {
        'id': device_id,
        'sid': request.sid,
        'name': f'Device-{device_id}',
        'type': 'unknown',
        'connected_at': datetime.now().isoformat()
    }
    emit('welcome', {
        'deviceId': device_id,
        'serverIP': get_local_ip(),
        'dbConnected': mongo_connected
    })
    broadcast_device_list()
    print(f"[+] Device connected: {device_id}")


@socketio.on('disconnect')
def handle_disconnect():
    device = devices.pop(request.sid, None)
    if device:
        print(f"[-] Device disconnected: {device['id']}")
        broadcast_device_list()


@socketio.on('register')
def handle_register(data):
    if request.sid in devices:
        name = data.get('name', devices[request.sid]['name'])
        dtype = data.get('deviceType', 'laptop')
        devices[request.sid]['name'] = name
        devices[request.sid]['type'] = dtype
        # Persist to MongoDB
        register_device_db(devices[request.sid]['id'], name, dtype)
        print(f"[*] Registered: {name} ({dtype})")
        broadcast_device_list()


@socketio.on('file-offer')
def handle_file_offer(data):
    target_sid = find_sid_by_device_id(data.get('targetId'))
    if target_sid:
        sender = devices.get(request.sid, {})
        emit('file-offer', {
            'senderId': sender.get('id'),
            'senderName': sender.get('name'),
            'fileName': data.get('fileName'),
            'fileSize': data.get('fileSize'),
            'fileType': data.get('fileType'),
            'gestureType': data.get('gestureType', 'drag'),
            'transferId': data.get('transferId')
        }, to=target_sid)


@socketio.on('file-accept')
def handle_file_accept(data):
    target_sid = find_sid_by_device_id(data.get('senderId'))
    if target_sid:
        emit('file-accepted', {'transferId': data.get('transferId')}, to=target_sid)


@socketio.on('file-reject')
def handle_file_reject(data):
    target_sid = find_sid_by_device_id(data.get('senderId'))
    if target_sid:
        sender = devices.get(request.sid, {})
        log_transfer(
            data.get('senderId'), 'Unknown',
            sender.get('id'),
            data.get('fileName', 'unknown'), 0,
            'unknown', status='rejected'
        )
        emit('file-rejected', {'transferId': data.get('transferId')}, to=target_sid)


@socketio.on('file-chunk')
def handle_file_chunk(data):
    target_sid = find_sid_by_device_id(data.get('targetId'))
    if target_sid:
        emit('file-chunk', {
            'transferId': data.get('transferId'),
            'chunk': data.get('chunk'),
            'chunkIndex': data.get('chunkIndex'),
            'totalChunks': data.get('totalChunks'),
            'fileName': data.get('fileName')
        }, to=target_sid)


@socketio.on('file-complete')
def handle_file_complete(data):
    target_sid = find_sid_by_device_id(data.get('targetId'))
    sender = devices.get(request.sid, {})
    # Log to MongoDB
    log_transfer(
        sender.get('id'), sender.get('name'),
        data.get('targetId'),
        data.get('fileName', 'unknown'),
        data.get('fileSize', 0),
        data.get('gestureType', 'drag'),
        status='completed'
    )
    if target_sid:
        emit('file-complete', {
            'transferId': data.get('transferId'),
            'fileName': data.get('fileName')
        }, to=target_sid)


@socketio.on('clipboard-share')
def handle_clipboard_share(data):
    target_sid = find_sid_by_device_id(data.get('targetId'))
    sender = devices.get(request.sid, {})
    # Log to MongoDB
    log_clipboard(
        sender.get('id'), sender.get('name'),
        data.get('targetId'),
        data.get('content', ''),
        data.get('contentType', 'text')
    )
    if target_sid:
        emit('clipboard-receive', {
            'senderId': sender.get('id'),
            'senderName': sender.get('name'),
            'content': data.get('content'),
            'contentType': data.get('contentType', 'text')
        }, to=target_sid)


@socketio.on('gesture-event')
def handle_gesture_event(data):
    target_sid = find_sid_by_device_id(data.get('targetId'))
    sender = devices.get(request.sid, {})
    if target_sid:
        emit('remote-gesture', {
            'senderId': sender.get('id'),
            'gesture': data.get('gesture'),
            'position': data.get('position')
        }, to=target_sid)


def find_sid_by_device_id(device_id):
    for sid, device in devices.items():
        if device['id'] == device_id:
            return sid
    return None


def broadcast_device_list():
    device_list = []
    for sid, device in devices.items():
        device_list.append({
            'id': device['id'],
            'name': device['name'],
            'type': device['type'],
            'connectedAt': device['connected_at']
        })
    socketio.emit('device-list', {'devices': device_list})


if __name__ == '__main__':
    local_ip = get_local_ip()
    port = 5000
    print()
    print('=================================================')
    print('        AirShare Server Running')
    print('=================================================')
    print(f'  Local:   http://localhost:{port}')
    print(f'  Network: http://{local_ip}:{port}')
    print(f'  MongoDB: {"Connected" if mongo_connected else "NOT connected"}')
    print('-------------------------------------------------')
    print('  Open on multiple devices to start sharing!')
    print('=================================================')
    print()
    socketio.run(app, host='0.0.0.0', port=port, debug=True, allow_unsafe_werkzeug=True)
