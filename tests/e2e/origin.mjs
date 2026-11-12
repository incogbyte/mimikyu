import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const port = Number(process.env.PORT || 8080);

function readBody(request) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        request.on('data', (chunk) => chunks.push(chunk));
        request.on('end', () => resolve(Buffer.concat(chunks)));
        request.on('error', reject);
    });
}

function requestHeaders(request) {
    return {
        cookie: request.headers.cookie || '',
        origin: request.headers.origin || '',
        referer: request.headers.referer || '',
        userAgent: request.headers['user-agent'] || '',
    };
}

function parseMultipart(body, contentType) {
    const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/iu.exec(contentType || '');
    if (!boundaryMatch) return [];
    const boundary = `--${boundaryMatch[1] || boundaryMatch[2]}`;
    return body
        .toString('latin1')
        .split(boundary)
        .slice(1, -1)
        .map((part) => part.replace(/^\r\n|\r\n$/gu, ''))
        .map((part) => {
            const separator = part.indexOf('\r\n\r\n');
            if (separator < 0) return null;
            const headers = part.slice(0, separator);
            const value = part.slice(separator + 4);
            const name = /name="([^"]+)"/iu.exec(headers)?.[1] || '';
            const filename = /filename="([^"]*)"/iu.exec(headers)?.[1];
            return { name, filename, size: Buffer.byteLength(value, 'latin1') };
        })
        .filter(Boolean);
}

function writeWebSocketFrame(socket, payload, opcode = 1) {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    const header = data.length < 126
        ? Buffer.from([0x80 | opcode, data.length])
        : Buffer.concat([Buffer.from([0x80 | opcode, 126]), Buffer.from([data.length >> 8, data.length & 255])]);
    socket.write(Buffer.concat([header, data]));
}

function handleWebSocket(request, socket, head) {
    const key = request.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
        socket.destroy();
        return;
    }
    const accept = createHash('sha1')
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64');
    socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    let buffer = Buffer.from(head || Buffer.alloc(0));
    const consume = () => {
        while (buffer.length >= 2) {
            const first = buffer[0];
            const second = buffer[1];
            const masked = (second & 0x80) !== 0;
            let length = second & 0x7f;
            let offset = 2;
            if (length === 126) {
                if (buffer.length < 4) return;
                length = buffer.readUInt16BE(2);
                offset = 4;
            }
            if (length === 127 || !masked || buffer.length < offset + 4 + length) return;
            const mask = buffer.subarray(offset, offset + 4);
            offset += 4;
            const payload = Buffer.alloc(length);
            for (let index = 0; index < length; index += 1) {
                payload[index] = buffer[offset + index] ^ mask[index % 4];
            }
            buffer = buffer.subarray(offset + length);
            const opcode = first & 0x0f;
            if (opcode === 8) {
                writeWebSocketFrame(socket, Buffer.alloc(0), 8);
                socket.end();
                return;
            }
            if (opcode === 9) writeWebSocketFrame(socket, payload, 10);
            else if (opcode === 1 || opcode === 2) writeWebSocketFrame(socket, payload, opcode);
        }
    };
    socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        consume();
    });
}

const server = createServer(async (request, response) => {
    const body = await readBody(request);
    const url = new URL(request.url || '/', `http://${request.headers.host || 'origin'}`);

    if (url.pathname === '/navigation') {
        const html = '<!doctype html><html><body>mimikyu-navigation-ok</body></html>';
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(html);
        return;
    }

    if (url.pathname === '/set-cookie') {
        response.writeHead(200, {
            'content-type': 'text/plain',
            'set-cookie': ['mimikyu_cookie=browser-session; Path=/'],
        });
        response.end('cookie-set');
        return;
    }

    if (url.pathname === '/image') {
        response.writeHead(200, { 'content-type': 'image/png' });
        response.end(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        return;
    }

    if (url.pathname === '/stream') {
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        for (const chunk of ['chunk-1\n', 'chunk-2\n', 'chunk-3\n']) {
            response.write(chunk);
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        response.end('stream-end\n');
        return;
    }

    if (url.pathname === '/upload' && request.method === 'POST') {
        const contentType = String(request.headers['content-type'] || '');
        const parts = contentType.startsWith('multipart/form-data')
            ? parseMultipart(body, contentType)
            : [];
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ bytes: body.length, parts }));
        return;
    }

    if (url.pathname === '/api/echo' || url.pathname === '/form') {
        const payload = JSON.stringify({
            path: url.pathname,
            method: request.method,
            body: body.toString('utf8'),
            headers: requestHeaders(request),
        });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(payload);
        return;
    }

    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not-found');
});

server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'origin'}`);
    if (url.pathname === '/ws') handleWebSocket(request, socket, head);
    else socket.destroy();
});

server.listen(port, '0.0.0.0', () => {
    process.stdout.write(`[origin] listening on ${port}\n`);
});
