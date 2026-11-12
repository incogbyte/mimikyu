import assert from 'node:assert/strict';
import net from 'node:net';

const base = process.env.MIMIKYU_ORIGIN_URL || 'http://127.0.0.1:18081';

const stream = await fetch(`${base}/stream`);
assert.equal(stream.status, 200);
assert.equal(await stream.text(), 'chunk-1\nchunk-2\nchunk-3\nstream-end\n');

const boundary = 'mimikyu-test-boundary';
const multipart = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="field"\r\n\r\nvalue\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="test.txt"\r\nContent-Type: text/plain\r\n\r\nhello\r\n` +
    `--${boundary}--\r\n`,
);
const upload = await fetch(`${base}/upload`, {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body: multipart,
});
assert.equal(upload.status, 200);
const uploadResult = await upload.json();
assert.equal(uploadResult.parts.length, 2);
assert.equal(uploadResult.parts[1].filename, 'test.txt');

function maskedFrame(text) {
    const payload = Buffer.from(text);
    const mask = Buffer.from([1, 2, 3, 4]);
    const header = Buffer.from([0x81, 0x80 | payload.length]);
    const encoded = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
    return Buffer.concat([header, mask, encoded]);
}

const websocketEcho = await new Promise((resolve, reject) => {
    const socket = net.connect(18081, '127.0.0.1');
    let buffer = Buffer.alloc(0);
    let handshake = false;
    const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('origin WebSocket smoke timed out'));
    }, 5000);
    socket.on('connect', () => {
        socket.write(
            'GET /ws HTTP/1.1\r\n' +
            'Host: 127.0.0.1:18081\r\n' +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
            'Sec-WebSocket-Version: 13\r\n\r\n',
        );
    });
    socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (!handshake) {
            const separator = buffer.indexOf('\r\n\r\n');
            if (separator < 0) return;
            const response = buffer.subarray(0, separator).toString('latin1');
            assert.match(response, /101 Switching Protocols/u);
            buffer = buffer.subarray(separator + 4);
            handshake = true;
            socket.write(maskedFrame('mimikyu-ws-ok'));
        }
        if (handshake && buffer.length >= 2) {
            const length = buffer[1] & 0x7f;
            if (buffer.length >= 2 + length) {
                clearTimeout(timer);
                resolve(buffer.subarray(2, 2 + length).toString('utf8'));
                socket.destroy();
            }
        }
    });
    socket.on('error', reject);
});
assert.equal(websocketEcho, 'mimikyu-ws-ok');

console.log('Protocol origin smoke passed');
