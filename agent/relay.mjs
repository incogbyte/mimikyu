import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

import {
    applyRequestCookies,
    executeFetch,
    executeForm,
    executeNavigation,
    executeResource,
    createWebSocketBridge,
} from './browser-executor.mjs';
import { runAfterHook, runBeforeHook } from './hook-runner.mjs';
import { browserFetchHeaders, classifyRequest, getPageUrl } from './request-classifier.mjs';

const TOKEN_HEADER = 'x-mimikyu-token';
const SCHEME_HEADER = 'x-mimikyu-scheme';
const HOST_HEADER = 'x-mimikyu-host';
const PORT_HEADER = 'x-mimikyu-port';
const TRACE_HEADER = 'x-mimikyu-trace';
const MAX_BODY_HEADER = 'x-mimikyu-max-body-bytes';
const COOKIE_MODE_HEADER = 'x-mimikyu-cookie-mode';
const REJECT_HEADER = 'x-mimikyu-reject';
const INTERNAL_HEADERS = new Set([
    TOKEN_HEADER,
    SCHEME_HEADER,
    HOST_HEADER,
    PORT_HEADER,
    TRACE_HEADER,
    MAX_BODY_HEADER,
    COOKIE_MODE_HEADER,
    REJECT_HEADER,
]);
const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;

function tokenMatches(candidate, expected) {
    const left = Buffer.from(candidate || '');
    const right = Buffer.from(expected);
    return left.length === right.length && timingSafeEqual(left, right);
}

function writeError(response, statusCode, message) {
    response.writeHead(statusCode, {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': Buffer.byteLength(message),
        connection: 'close',
    });
    response.end(message);
}

function readBody(request, maximum) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        request.on('data', (chunk) => {
            size += chunk.length;
            if (size > maximum) {
                reject(Object.assign(new Error('Request body exceeds configured limit'), { statusCode: 413 }));
                request.destroy();
                return;
            }
            chunks.push(chunk);
        });
        request.on('end', () => resolve(Buffer.concat(chunks)));
        request.on('error', reject);
    });
}

function targetUrl(request) {
    const scheme = String(request.headers[SCHEME_HEADER] || '').toLowerCase();
    const host = String(request.headers[HOST_HEADER] || '');
    const port = String(request.headers[PORT_HEADER] || '');
    if (scheme !== 'http' && scheme !== 'https') {
        throw Object.assign(new Error('Invalid target scheme'), { statusCode: 400 });
    }
    if (!/^[a-zA-Z0-9.[\]:_-]+$/.test(host) || host.length > 255) {
        throw Object.assign(new Error('Invalid target host'), { statusCode: 400 });
    }
    if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
        throw Object.assign(new Error('Invalid target port'), { statusCode: 400 });
    }
    const path = request.url?.startsWith('http://') || request.url?.startsWith('https://')
        ? new URL(request.url).pathname + new URL(request.url).search
        : request.url || '/';
    return `${scheme}://${host}:${port}${path}`;
}

function responseHeaders(headers, body) {
    const result = { ...headers };
    result['content-length'] = body.length;
    return result;
}

function streamingHeaders(headers) {
    const result = { ...headers };
    delete result['content-length'];
    return result;
}

function requestHeaders(request) {
    const result = {};
    for (const [key, value] of Object.entries(request.headers || {})) {
        if (INTERNAL_HEADERS.has(key.toLowerCase())) continue;
        result[key] = value;
    }
    return result;
}

export function createRelay({
    token,
    browserManager,
    port = 0,
    host = '127.0.0.1',
    onRequest = () => {},
    beforeHookPath,
    afterHookPath,
    isReady = () => browserManager.connected,
}) {
    const server = createServer(async (request, response) => {
        if (request.url === '/health') {
            const ready = isReady();
            const body = JSON.stringify({ browser: ready ? 'connected' : 'unavailable' });
            response.writeHead(ready ? 200 : 503, {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(body),
            });
            response.end(body);
            return;
        }

        const trace = String(request.headers[TRACE_HEADER] || 'unknown');
        const started = Date.now();
        try {
            if (!tokenMatches(request.headers[TOKEN_HEADER], token)) {
                writeError(response, 403, 'Invalid Mimikyu agent token');
                return;
            }
            if (request.headers[REJECT_HEADER] === 'true') {
                writeError(response, 503, 'Mimikyu routing is unavailable; direct fallback is disabled');
                return;
            }
            if (!isReady()) {
                writeError(response, 503, 'Mimikyu browser is not ready');
                return;
            }
            const url = targetUrl(request);
            const maximumHeader = Number(request.headers[MAX_BODY_HEADER]);
            const maximum = Number.isFinite(maximumHeader) && maximumHeader > 0
                ? maximumHeader
                : DEFAULT_MAX_BODY_BYTES;
            const body = await readBody(request, Math.min(maximum, 1024 * 1024 * 1024));
            const headers = requestHeaders(request);
            const route = classifyRequest({ method: request.method, headers });
            if (route.kind === 'unsupported-resource') {
                writeError(response, 501, `Resource route is not implemented: ${route.destination}`);
                return;
            }
            const cookieMode = request.headers[COOKIE_MODE_HEADER] === 'isolated-cloned'
                ? 'isolated-cloned'
                : request.headers[COOKIE_MODE_HEADER] === 'isolated'
                    ? 'isolated'
                    : 'shared';
            const target = await browserManager.acquireTarget({ cookieMode });
            try {
                await applyRequestCookies(target, url, headers);
                const hookRequest = {
                    id: trace,
                    url,
                    method: request.method || 'GET',
                    headers,
                    body,
                };
                await runBeforeHook(beforeHookPath, target, hookRequest);
                let responseStarted = false;
                const onHeaders = (info) => {
                    if (responseStarted) return;
                    response.writeHead(info.statusCode, streamingHeaders(info.headers));
                    responseStarted = true;
                };
                const onChunk = (chunk) => {
                    if (!responseStarted) return;
                    if (request.method !== 'HEAD') response.write(chunk);
                };
                const streamOptions = { onHeaders, onChunk };
                const result = route.kind === 'navigation'
                    ? await executeNavigation(target, url, streamOptions)
                    : route.kind === 'resource'
                        ? await executeResource(target, {
                            url,
                            pageUrl: getPageUrl(url, headers),
                            destination: route.destination,
                            ...streamOptions,
                        })
                        : route.kind === 'form'
                            ? await executeForm(target, {
                                url,
                                pageUrl: getPageUrl(url, headers),
                                method: request.method || 'POST',
                                body,
                                contentType: String(headers['content-type'] || ''),
                                ...streamOptions,
                            })
                        : await executeFetch(target, {
                            url,
                            pageUrl: getPageUrl(url, headers),
                            method: request.method || 'GET',
                            headers: browserFetchHeaders(headers),
                            body,
                            ...streamOptions,
                        });
                try {
                    await runAfterHook(afterHookPath, target, hookRequest, result);
                } catch (hookError) {
                    process.stderr.write(`[Mimikyu] after-request hook failed: ${String(hookError)}\n`);
                }
                if (!responseStarted) {
                    response.writeHead(
                        result.statusCode,
                        responseHeaders(result.headers, result.body),
                    );
                    responseStarted = true;
                }
                response.end();
                onRequest({ trace, outcome: 'succeeded', statusCode: result.statusCode, durationMs: Date.now() - started });
            } finally {
                await browserManager.releaseTarget(target);
            }
        } catch (error) {
            const statusCode = Number(error?.statusCode) || 502;
            const message = error instanceof Error ? error.message : String(error);
            if (response.headersSent) response.destroy();
            else writeError(response, statusCode, message);
            onRequest({ trace, outcome: 'failed', error: message, durationMs: Date.now() - started });
        }
    });
    const webSocketServer = new WebSocketServer({ noServer: true });
    server.on('upgrade', (request, socket, head) => {
        const trace = String(request.headers[TRACE_HEADER] || 'unknown');
        if (!tokenMatches(request.headers[TOKEN_HEADER], token)) {
            socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
            return;
        }
        if (request.headers[REJECT_HEADER] === 'true' || !isReady()) {
            socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
            return;
        }
        webSocketServer.handleUpgrade(request, socket, head, async (client) => {
            const started = Date.now();
            let target;
            let bridge;
            let opened = false;
            let released = false;
            const release = async () => {
                if (released) return;
                released = true;
                await browserManager.releaseTarget(target).catch(() => {});
            };
            try {
                const queue = [];
                client.on('message', (data, binary) => {
                    const message = binary ? data : data.toString();
                    process.stdout.write(`${JSON.stringify({ event: 'websocket', phase: 'client-message', binary: Boolean(binary) })}\n`);
                    if (opened && bridge) void bridge.send(message, binary);
                    else queue.push({ data: message, binary });
                });
                const url = targetUrl(request);
                const webSocketUrl = url.replace(/^http/u, 'ws');
                const headers = requestHeaders(request);
                const pageUrl = getPageUrl(url, headers);
                const protocols = String(request.headers['sec-websocket-protocol'] || '')
                    .split(',')
                    .map((value) => value.trim())
                    .filter(Boolean);
                target = await browserManager.acquireTarget();
                await applyRequestCookies(target, url, headers);
                bridge = await createWebSocketBridge(target, {
                    url: webSocketUrl,
                    pageUrl,
                    protocols,
                    onOpen: () => {
                        opened = true;
                        for (const message of queue.splice(0)) bridge.send(message.data, message.binary);
                        onRequest({ trace, outcome: 'succeeded', statusCode: 101, durationMs: Date.now() - started });
                    },
                    onMessage: (data, binary) => {
                        process.stdout.write(`${JSON.stringify({ event: 'websocket', phase: 'browser-message', binary: Boolean(binary) })}\n`);
                        if (client.readyState === 1) client.send(data, { binary });
                    },
                    onClose: (code, reason) => {
                        if (client.readyState === 1) client.close(code || 1000, reason || '');
                        void release();
                    },
                    onError: (error) => {
                        if (client.readyState === 1) client.close(1011, String(error).slice(0, 120));
                        void release();
                    },
                });
                client.on('close', () => {
                    void bridge?.close();
                    void release();
                });
                client.on('error', () => {
                    void bridge?.close();
                    void release();
                });
            } catch (error) {
                client.close();
                await release();
                onRequest({ trace, outcome: 'failed', error: String(error), durationMs: Date.now() - started });
            }
        });
    });

    return {
        server,
        listen: () => new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(port, host, () => resolve(server.address()));
        }),
        close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    };
}
