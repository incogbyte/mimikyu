import { createServer } from 'node:http';

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

server.listen(port, '0.0.0.0', () => {
    process.stdout.write(`[origin] listening on ${port}\n`);
});
