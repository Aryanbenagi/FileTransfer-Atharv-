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
try:
    from pymongo import MongoClient
    from pymongo.errors import ConnectionFailure
    HAS_PYMONGO = True
except ImportError:
    HAS_PYMONGO = False
try:
    import qrcode
    HAS_QRCODE = True
except ImportError:
    HAS_QRCODE = False

app = Flask(__name__, static_folder='static', template_folder='templates')
app.config['SECRET_KEY'] = 'airshare-secret-key-2024'
app.config['MAX_CONTENT_LENGTH'] = 500 * 1024 * 1024

socketio = SocketIO(app, cors_allowed_origins="*", max_http_buffer_size=100 * 1024 * 1024,
                    ping_timeout=60, ping_interval=25)

# ─── MongoDB Setup with Memory Fallback ───────────────────
MONGO_URI = os.environ.get('MONGO_URI', 'mongodb://localhost:27017/')
DB_NAME = 'airshare'
mongo_connected = False
db = None

# In-memory fallback storage
memory_store = {
    'devices': [],
    'transfers': [],
    'clipboard': [],
    'settings': {}
}


class MemoryCollection:
    """In-memory fallback that mimics basic MongoDB collection operations."""
    def __init__(self, name):
        self.name = name
        self.data = memory_store.get(name, [])

    def insert_one(self, doc):
        doc = dict(doc)
        doc['_mem_id'] = str(uuid.uuid4())
        self.data.append(doc)
        # Keep memory bounded
        if len(self.data) > 500:
            self.data[:] = self.data[-500:]

    def find(self, query=None, projection=None):
        return MemoryCursor(self.data, query)

    def find_one(self, query=None, projection=None):
        for item in self.data:
            if self._matches(item, query or {}):
                result = dict(item)
                result.pop('_mem_id', None)
                if projection:
                    result.pop('_id', None)
                return result
        return None

    def update_one(self, query, update, upsert=False):
        for item in self.data:
            if self._matches(item, query):
                if '$set' in update:
                    item.update(update['$set'])
                if '$inc' in update:
                    for k, v in update['$inc'].items():
                        item[k] = item.get(k, 0) + v
                return
        if upsert:
            new_doc = dict(query)
            if '$set' in update:
                new_doc.update(update['$set'])
            if '$inc' in update:
                for k, v in update['$inc'].items():
                    new_doc[k] = v
            self.insert_one(new_doc)

    def count_documents(self, query=None):
        if not query:
            return len(self.data)
        return sum(1 for item in self.data if self._matches(item, query))

    def aggregate(self, pipeline):
        # Simple support for $group with $sum
        if pipeline and pipeline[0].get('$group'):
            group = pipeline[0]['$group']
            total_field = None
            for key, val in group.items():
                if key != '_id' and isinstance(val, dict) and '$sum' in val:
                    field = val['$sum'].lstrip('$')
                    total = sum(item.get(field, 0) for item in self.data)
                    return [{'_id': None, key: total}]
        return []

    def delete_many(self, query=None):
        if not query:
            self.data.clear()
        else:
            self.data[:] = [item for item in self.data if not self._matches(item, query)]

    def _matches(self, item, query):
        for key, val in query.items():
            if item.get(key) != val:
                return False
        return True


class MemoryCursor:
    """Mimics a MongoDB cursor for memory operations."""
    def __init__(self, data, query=None):
        self.data = list(data)
        if query:
            self.data = [d for d in self.data if all(d.get(k) == v for k, v in query.items())]

    def sort(self, field, direction=-1):
        try:
            self.data.sort(key=lambda x: x.get(field, ''), reverse=(direction == -1))
        except TypeError:
            pass
        return self

    def limit(self, n):
        self.data = self.data[:n]
        return self

    def __iter__(self):
        for item in self.data:
            result = dict(item)
            result.pop('_mem_id', None)
            result.pop('_id', None)
            yield result

    def __list__(self):
        return list(self.__iter__())


# Try connecting to MongoDB
if HAS_PYMONGO:
    try:
        mongo_client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=3000)
        mongo_client.admin.command('ping')
        db = mongo_client[DB_NAME]
        print('[MongoDB] Connected successfully')
        mongo_connected = True
    except Exception:
        print('[MongoDB] WARNING: Could not connect. Using in-memory storage.')
        db = None
        mongo_connected = False
else:
    print('[MongoDB] pymongo not installed. Using in-memory storage.')


def get_col(name):
    """Safely get a collection. Falls back to memory storage if no DB."""
    if db is not None:
        return db[name]
    return MemoryCollection(name)


# ─── In-memory connected devices (live sessions) ──────────
devices = {}
# Track clipboard content for real-time sync
clipboard_content = {}

# ─── Room codes for cross-network connections ──────────────
import random
import string
rooms = {}  # room_code -> { 'members': set(sid), 'created': iso_str }

def generate_room_code():
    return ''.join(random.choices(string.digits, k=6))

UPLOAD_FOLDER = os.path.join(os.path.dirname(__file__), 'shared_files')
os.makedirs(UPLOAD_FOLDER, exist_ok=True)


def get_local_ip():
    """Detect local network IP using multiple fallback methods."""
    # Method 1: UDP socket probe (works when internet is available)
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(2)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        if ip and ip != "0.0.0.0":
            return ip
    except Exception:
        pass

    # Method 2: hostname resolution
    try:
        hostname = socket.gethostname()
        ip = socket.gethostbyname(hostname)
        if ip and ip != "127.0.0.1" and not ip.startswith("127."):
            return ip
    except Exception:
        pass

    # Method 3: scan all network interfaces via getaddrinfo
    try:
        hostname = socket.gethostname()
        addrs = socket.getaddrinfo(hostname, None, socket.AF_INET)
        for addr in addrs:
            ip = addr[4][0]
            if ip and not ip.startswith("127."):
                return ip
    except Exception:
        pass

    # Method 4: parse ipconfig/ifconfig output (Windows/macOS/Linux)
    try:
        import subprocess
        # Try ipconfig (Windows)
        try:
            result = subprocess.run(["ipconfig"], capture_output=True, text=True, timeout=5)
            for line in result.stdout.split("\n"):
                line = line.strip()
                if "IPv4" in line and ":" in line:
                    ip = line.split(":")[-1].strip()
                    if ip and not ip.startswith("127."):
                        return ip
        except Exception:
            pass

        # Try ifconfig (macOS/Linux)
        try:
            result = subprocess.run(["ifconfig"], capture_output=True, text=True, timeout=5)
            for line in result.stdout.split("\n"):
                line = line.strip()
                if line.startswith("inet "):
                    parts = line.split()
                    if len(parts) > 1:
                        ip = parts[1]
                        if ip and not ip.startswith("127."):
                            return ip
        except Exception:
            pass
    except Exception:
        pass

    return "127.0.0.1"


# ─── REST API Routes ──────────────────────────────────────

@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/connection-info')
def connection_info():
    """Return the server's network URL for other devices to connect."""
    local_ip = get_local_ip()
    port = 5003
    scheme = request.scheme
    url = f'{scheme}://{local_ip}:{port}'
    return jsonify({
        'url': url,
        'ip': local_ip,
        'port': port,
        'activeDevices': len(devices)
    })


@app.route('/api/qr')
def qr_code():
    """Generate a QR code SVG/PNG for the server URL."""
    if not HAS_QRCODE:
        # Return a simple text fallback
        return jsonify({'error': 'qrcode library not installed. pip install qrcode pillow'}), 500

    try:
        local_ip = get_local_ip()
        # Dynamically determine the URL based on request host to support different ports and IPs
        url = request.url_root.rstrip('/')
        if '127.0.0.1' in url or 'localhost' in url:
            port = request.host.split(':')[-1] if ':' in request.host else '5003'
            scheme = request.scheme
            url = f'{scheme}://{local_ip}:{port}'

        qr = qrcode.QRCode(version=1, box_size=8, border=2)
        qr.add_data(url)
        qr.make(fit=True)

        # Try to generate vector SVG QR code first
        try:
            import qrcode.image.svg
            img = qr.make_image(image_factory=qrcode.image.svg.SvgImage, fill_color='#6366f1', back_color='#0a0a1a')
            buf = io.BytesIO()
            img.save(buf)
            buf.seek(0)
            return Response(buf.getvalue(), mimetype='image/svg+xml',
                            headers={'Cache-Control': 'no-cache, no-store, must-revalidate'})
        except Exception as svg_err:
            print(f'[QR] SVG generation failed, falling back to PNG: {svg_err}')
            # Fallback to PNG
            img = qr.make_image(fill_color='#6366f1', back_color='#0a0a1a')
            buf = io.BytesIO()
            img.save(buf, format='PNG')
            buf.seek(0)
            return Response(buf.getvalue(), mimetype='image/png',
                            headers={'Cache-Control': 'no-cache, no-store, must-revalidate'})
    except Exception as e:
        print(f'[QR] Error generating QR code: {e}')
        # Return a 1x1 transparent PNG as fallback
        return Response(
            b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n\xb4\x00\x00\x00\x00IEND\xaeB`\x82',
            mimetype='image/png'
        )


@app.route('/api/transfers', methods=['GET'])
def get_transfers():
    """Get transfer history."""
    col = get_col('transfers')
    transfers = list(col.find({}, {'_id': 0}).sort('timestamp', -1).limit(50))
    return jsonify({'transfers': transfers, 'dbConnected': mongo_connected or True})


@app.route('/api/transfers/clear', methods=['POST'])
def clear_transfers():
    col = get_col('transfers')
    col.delete_many({})
    return jsonify({'status': 'ok'})


@app.route('/api/clipboard', methods=['GET'])
def get_clipboard_history():
    col = get_col('clipboard')
    items = list(col.find({}, {'_id': 0}).sort('timestamp', -1).limit(20))
    return jsonify({'items': items, 'dbConnected': mongo_connected or True})


@app.route('/api/clipboard/clear', methods=['POST'])
def clear_clipboard():
    col = get_col('clipboard')
    col.delete_many({})
    return jsonify({'status': 'ok'})


@app.route('/api/settings/<device_id>', methods=['GET'])
def get_settings(device_id):
    col = get_col('settings')
    settings = col.find_one({'deviceId': device_id}, {'_id': 0})
    return jsonify({'settings': settings, 'dbConnected': mongo_connected or True})


@app.route('/api/settings/<device_id>', methods=['POST'])
def save_settings(device_id):
    col = get_col('settings')
    data = request.get_json()
    col.update_one(
        {'deviceId': device_id},
        {'$set': {**data, 'deviceId': device_id, 'updatedAt': datetime.now().isoformat()}},
        upsert=True
    )
    return jsonify({'status': 'ok'})


@app.route('/api/stats', methods=['GET'])
def get_stats():
    """Dashboard stats."""
    transfer_col = get_col('transfers')
    clip_col = get_col('clipboard')
    device_col = get_col('devices')

    total_transfers = transfer_col.count_documents({})
    total_bytes = 0
    pipeline = [{'$group': {'_id': None, 'total': {'$sum': '$fileSize'}}}]
    result = list(transfer_col.aggregate(pipeline))
    total_bytes = result[0]['total'] if result else 0

    total_clips = clip_col.count_documents({})
    total_devices = device_col.count_documents({})

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


@app.route('/api/room/create', methods=['POST'])
def create_room():
    code = generate_room_code()
    while code in rooms:
        code = generate_room_code()
    rooms[code] = {'members': set(), 'created': datetime.now().isoformat()}
    return jsonify({'code': code})


@app.route('/api/room/check/<code>', methods=['GET'])
def check_room(code):
    if code in rooms:
        return jsonify({'exists': True, 'members': len(rooms[code]['members'])})
    return jsonify({'exists': False})


# ─── MongoDB Helper Functions ─────────────────────────────

def log_transfer(sender_id, sender_name, receiver_id, file_name, file_size, gesture_type, status='completed'):
    col = get_col('transfers')
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
        'dbConnected': True  # Always true since we have memory fallback
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
        # Persist to storage
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
        # Notify sender's other tabs that a transfer is starting to the target
        emit('transfer-started', {
            'targetId': data.get('targetId'),
            'transferId': data.get('transferId')
        }, to=request.sid)


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
        # Acknowledge chunk received by server (for flow control)
        emit('chunk-ack', {
            'transferId': data.get('transferId'),
            'chunkIndex': data.get('chunkIndex')
        }, to=request.sid)


@socketio.on('file-complete')
def handle_file_complete(data):
    target_sid = find_sid_by_device_id(data.get('targetId'))
    sender = devices.get(request.sid, {})
    # Log to storage
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
            'fileName': data.get('fileName'),
            'fileSize': data.get('fileSize', 0)
        }, to=target_sid)


@socketio.on('clipboard-share')
def handle_clipboard_share(data):
    target_sid = find_sid_by_device_id(data.get('targetId'))
    sender = devices.get(request.sid, {})
    # Log to storage
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


@socketio.on('clipboard-typing')
def handle_clipboard_typing(data):
    """Real-time clipboard sync as user types."""
    target_sid = find_sid_by_device_id(data.get('targetId'))
    sender = devices.get(request.sid, {})
    if target_sid:
        emit('clipboard-typing', {
            'senderId': sender.get('id'),
            'senderName': sender.get('name'),
            'content': data.get('content', ''),
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


@socketio.on('device-receiving')
def handle_device_receiving(data):
    """Broadcast that a device is receiving a file (for glow effect)."""
    socketio.emit('device-receiving', {
        'deviceId': data.get('deviceId'),
        'receiving': data.get('receiving', False),
        'transferId': data.get('transferId')
    })


# ─── Room Code Events ─────────────────────────────────────

@socketio.on('join-room')
def handle_join_room(data):
    code = data.get('code', '')
    if code not in rooms:
        rooms[code] = {'members': set(), 'created': datetime.now().isoformat()}
    rooms[code]['members'].add(request.sid)
    device = devices.get(request.sid)
    if device:
        device['room'] = code
    emit('room-joined', {'code': code, 'members': len(rooms[code]['members'])})
    # Broadcast updated device list to all room members
    broadcast_device_list_to_room(code)
    print(f'[Room] {device["id"] if device else "?"} joined room {code}')


@socketio.on('leave-room')
def handle_leave_room(data):
    code = data.get('code', '')
    if code in rooms:
        rooms[code]['members'].discard(request.sid)
        if not rooms[code]['members']:
            del rooms[code]
        else:
            broadcast_device_list_to_room(code)
    device = devices.get(request.sid)
    if device:
        device.pop('room', None)


# ─── WebRTC Signaling Events ──────────────────────────────

@socketio.on('webrtc-offer')
def handle_webrtc_offer(data):
    target_sid = find_sid_by_device_id(data.get('targetId'))
    sender = devices.get(request.sid, {})
    if target_sid:
        emit('webrtc-offer', {
            'senderId': sender.get('id'),
            'offer': data.get('offer'),
            'transferId': data.get('transferId')
        }, to=target_sid)


@socketio.on('webrtc-answer')
def handle_webrtc_answer(data):
    target_sid = find_sid_by_device_id(data.get('targetId'))
    if target_sid:
        emit('webrtc-answer', {
            'answer': data.get('answer'),
            'transferId': data.get('transferId')
        }, to=target_sid)


@socketio.on('webrtc-ice')
def handle_webrtc_ice(data):
    target_sid = find_sid_by_device_id(data.get('targetId'))
    if target_sid:
        emit('webrtc-ice', {
            'candidate': data.get('candidate'),
            'transferId': data.get('transferId')
        }, to=target_sid)


@socketio.on('resume-transfer')
def handle_resume_transfer(data):
    """Handle resume request — relay to the sender."""
    target_sid = find_sid_by_device_id(data.get('senderId'))
    if target_sid:
        emit('resume-transfer', {
            'transferId': data.get('transferId'),
            'lastChunkIndex': data.get('lastChunkIndex', 0)
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


def broadcast_device_list_to_room(code):
    """Send device list to all members of a room."""
    if code not in rooms:
        return
    device_list = []
    for sid in rooms[code]['members']:
        device = devices.get(sid)
        if device:
            device_list.append({
                'id': device['id'],
                'name': device['name'],
                'type': device['type'],
                'connectedAt': device['connected_at'],
                'room': code
            })
    for sid in rooms[code]['members']:
        socketio.emit('room-device-list', {'devices': device_list, 'code': code}, to=sid)


if __name__ == '__main__':
    local_ip = get_local_ip()
    port = 5003
    
    key_path = os.path.join(os.path.dirname(__file__), 'certs', 'key.pem')
    cert_path = os.path.join(os.path.dirname(__file__), 'certs', 'cert.pem')
    
    ssl_enabled = os.path.exists(key_path) and os.path.exists(cert_path)
    protocol = "https" if ssl_enabled else "http"
    
    print()
    print('=================================================')
    print('        AirShare Server Running')
    print('=================================================')
    print(f'  Local:   {protocol}://localhost:{port}')
    print(f'  Network: {protocol}://{local_ip}:{port}')
    print(f'  MongoDB: {"Connected" if mongo_connected else "Memory fallback (no crash)"}')
    print(f'  SSL:     {"Enabled (HTTPS)" if ssl_enabled else "Disabled (Plain HTTP)"}')
    print('-------------------------------------------------')
    print('  Open on multiple devices to start sharing!')
    print('=================================================')
    print()
    
    if ssl_enabled:
        socketio.run(app, host='0.0.0.0', port=port, debug=True, allow_unsafe_werkzeug=True, keyfile=key_path, certfile=cert_path)
    else:
        socketio.run(app, host='0.0.0.0', port=port, debug=True, allow_unsafe_werkzeug=True)
