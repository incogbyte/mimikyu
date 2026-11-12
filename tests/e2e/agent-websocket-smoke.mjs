import assert from 'node:assert/strict';
import net from 'node:net';

const token = process.env.MIMIKYU_E2E_TOKEN || 'change-this-development-token';

function maskedFrame(text) {
    const payload = Buffer.from(text);
    const mask = Buffer.from([9, 8, 7, 6]);
    const header = Buffer.from([0x81, 0x80 | payload.length]);
    const encoded = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
    return Buffer.concat([header, mask, encoded]);
}

const echoed = await new Promise((resolve, reject) => {
    const socket = net.connect(38427, '127.0.0.1');
    let buffer = Buffer.alloc(0);
    let handshaken = false;
    const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('agent WebSocket smoke timed out'));
    }, 15_000);
    socket.on('connect', () => {
        socket.write(
            'GET /ws HTTP/1.1\r\n' +
            'Host: origin:8080\r\n' +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            'Sec-WebSocket-Key: MDEyMzQ1Njc4OWFiY2RlZg==\r\n' +
            'Sec-WebSocket-Version: 13\r\n' +
            `X-Mimikyu-Token: ${token}\r\n` +
            'X-Mimikyu-Scheme: http\r\n' +
            'X-Mimikyu-Host: origin\r\n' +
            'X-Mimikyu-Port: 8080\r\n' +
            'X-Mimikyu-Trace: websocket-smoke\r\n' +
            'X-Mimikyu-Max-Body-Bytes: 8388608\r\n\r\n',
        );
    });
    socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (!handshaken) {
            const separator = buffer.indexOf('\r\n\r\n');
            if (separator < 0) return;
            assert.match(buffer.subarray(0, separator).toString('latin1'), /101 Switching Protocols/u);
            buffer = buffer.subarray(separator + 4);
            handshaken = true;
            socket.write(maskedFrame('agent-ws-ok'));
        }
        if (handshaken && buffer.length >= 2) {
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

assert.equal(echoed, 'agent-ws-ok');
console.log('Agent WebSocket smoke passed');
