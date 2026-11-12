import assert from 'node:assert/strict';
import net from 'node:net';

const proxyPort = Number(process.env.MIMIKYU_CAIDO_PROXY_PORT || 18080);
const targetHost = process.env.MIMIKYU_WS_HOST || 'host.docker.internal';
const targetPort = Number(process.env.MIMIKYU_WS_PORT || 18081);

function maskedFrame(text) {
    const payload = Buffer.from(text);
    const mask = Buffer.from([5, 6, 7, 8]);
    const header = Buffer.from([0x81, 0x80 | payload.length]);
    const encoded = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
    return Buffer.concat([header, mask, encoded]);
}

const result = await new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, '127.0.0.1');
    let buffer = Buffer.alloc(0);
    let handshaken = false;
    const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('Caido WebSocket smoke timed out'));
    }, 30_000);
    socket.on('connect', () => {
        socket.write(
            `GET ws://${targetHost}:${targetPort}/ws HTTP/1.1\r\n` +
            `Host: ${targetHost}:${targetPort}\r\n` +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            'Sec-WebSocket-Key: MDEyMzQ1Njc4OWFiY2RlZg==\r\n' +
            'Sec-WebSocket-Version: 13\r\n\r\n',
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
            socket.write(maskedFrame('caido-ws-ok'));
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

assert.equal(result, 'caido-ws-ok');
console.log('Caido WebSocket smoke passed');
