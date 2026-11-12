const REQUEST_TIMEOUT_MS = 30_000;
const HOP_BY_HOP_HEADERS = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'proxy-connection',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
]);

function cookieHeaderValue(headers) {
    for (const [key, value] of Object.entries(headers || {})) {
        if (key.toLowerCase() !== 'cookie') continue;
        return Array.isArray(value) ? value.join('; ') : String(value);
    }
    return '';
}

export async function applyRequestCookies(target, url, headers) {
    const header = cookieHeaderValue(headers);
    if (header === '') return;
    const cookies = header.split(';').flatMap((part) => {
        const separator = part.indexOf('=');
        if (separator <= 0) return [];
        const name = part.slice(0, separator).trim();
        const value = part.slice(separator + 1).trim();
        if (name === '') return [];
        return [{ name, value, url }];
    });
    if (cookies.length > 0) {
        await target.tab.Network.setCookies({ cookies });
    }
}

function captureUrlFor(url) {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.toString();
}

function responseHeadersToObject(headers) {
    const result = {};
    for (const header of headers || []) {
        if (!header || typeof header.name !== 'string') continue;
        const name = header.name.toLowerCase();
        if (
            HOP_BY_HOP_HEADERS.has(name) ||
            name === 'content-length' ||
            name === 'content-encoding'
        ) continue;
        const value = typeof header.value === 'string' ? header.value : String(header.value ?? '');
        if (result[name] === undefined) result[name] = value;
        else if (Array.isArray(result[name])) result[name].push(value);
        else result[name] = [result[name], value];
    }
    return result;
}

function responseHeadersToFulfill(headers, body) {
    const result = [];
    for (const header of headers || []) {
        if (!header || typeof header.name !== 'string') continue;
        const name = header.name.toLowerCase();
        if (
            HOP_BY_HOP_HEADERS.has(name) ||
            name === 'content-length' ||
            name === 'content-encoding'
        ) continue;
        result.push({ name: header.name, value: String(header.value ?? '') });
    }
    result.push({ name: 'Content-Length', value: String(body.length) });
    return result;
}

function responseHasNoBody(method, statusCode) {
    return method === 'HEAD' ||
        statusCode === 204 ||
        statusCode === 304 ||
        (statusCode >= 100 && statusCode < 200) ||
        [301, 302, 303, 307, 308].includes(statusCode);
}

async function readResponseBody(Fetch, IO, Network, event, onChunk) {
    if (responseHasNoBody(event.request?.method, event.responseStatusCode)) {
        return Buffer.alloc(0);
    }
    try {
        if (IO && typeof Fetch.takeResponseBodyAsStream === 'function') {
            const stream = await Fetch.takeResponseBodyAsStream({ requestId: event.requestId });
            const chunks = [];
            try {
                while (true) {
                    const part = await IO.read({ handle: stream.stream });
                    const chunk = typeof part.data === 'string'
                        ? part.base64Encoded === true
                            ? Buffer.from(part.data, 'base64')
                            : Buffer.from(part.data)
                        : Buffer.alloc(0);
                    if (chunk.length > 0) {
                        chunks.push(chunk);
                        onChunk?.(chunk);
                    }
                    if (part.eof === true) break;
                }
            } finally {
                await IO.close({ handle: stream.stream }).catch(() => {});
            }
            return Buffer.concat(chunks);
        }
        const body = responseBodyToBuffer(await Fetch.getResponseBody({ requestId: event.requestId }));
        onChunk?.(body);
        return body;
    } catch (error) {
        if (event.networkId !== undefined && Network) {
            try {
                return responseBodyToBuffer(await Network.getResponseBody({ requestId: event.networkId }));
            } catch {
                // Fall through to the bounded empty-body fallback below.
            }
        }
        if (String(error).includes('Can only get response body')) {
            return Buffer.alloc(0);
        }
        throw error;
    }
}

function responseBodyToBuffer(result) {
    if (!result || typeof result.body !== 'string') return Buffer.alloc(0);
    return result.base64Encoded === true
        ? Buffer.from(result.body, 'base64')
        : Buffer.from(result.body);
}

function headerValue(headers, name) {
    const target = name.toLowerCase();
    for (const [key, value] of Object.entries(headers || {})) {
        if (key.toLowerCase() === target) return Array.isArray(value) ? value[0] : value;
    }
    return '';
}

function safeJson(value) {
    return JSON.stringify(value)
        .replaceAll('<', '\\u003c')
        .replaceAll('>', '\\u003e')
        .replaceAll('&', '\\u0026');
}

export async function createWebSocketBridge(target, {
    url,
    pageUrl,
    protocols = [],
    onOpen,
    onMessage,
    onClose,
    onError,
}) {
    const { Page, Runtime } = target.tab;
    const bindingName = `mimikyuWebSocket_${Math.random().toString(36).slice(2)}`;
    let closed = false;
    const bindingHandler = async (event) => {
        if (event.name !== bindingName || closed) return;
        try {
            const message = JSON.parse(event.payload);
            if (message.kind === 'open') onOpen?.();
            else if (message.kind === 'message') {
                const data = message.binary === true
                    ? Buffer.from(message.data, 'base64')
                    : message.data;
                onMessage?.(data, message.binary === true);
            } else if (message.kind === 'close') onClose?.(message.code, message.reason);
            else if (message.kind === 'error') onError?.(message.message);
        } catch (error) {
            onError?.(String(error));
        }
    };

    await Runtime.enable();
    await Page.enable();
    Runtime.bindingCalled(bindingHandler);
    await Runtime.addBinding({ name: bindingName });
    await Page.navigate({ url: pageUrl, transitionType: 'other' });
    await Runtime.evaluate({
        expression: `(() => {
            const emit = (value) => window[${safeJson(bindingName)}](JSON.stringify(value));
            const socket = new WebSocket(${safeJson(url)}, ${safeJson(protocols)});
            socket.binaryType = 'arraybuffer';
            socket.addEventListener('open', () => emit({ kind: 'open' }));
            socket.addEventListener('message', (event) => {
                if (event.data instanceof ArrayBuffer) {
                    const bytes = new Uint8Array(event.data);
                    let binary = '';
                    for (const byte of bytes) binary += String.fromCharCode(byte);
                    emit({ kind: 'message', binary: true, data: btoa(binary) });
                } else {
                    emit({ kind: 'message', binary: false, data: String(event.data) });
                }
            });
            socket.addEventListener('close', (event) => emit({ kind: 'close', code: event.code, reason: event.reason }));
            socket.addEventListener('error', () => emit({ kind: 'error', message: 'Browser WebSocket error' }));
            window.__mimikyuWebSocket = socket;
        })()`
    });

    return {
        send(data, binary = false) {
            const payload = binary
                ? `(() => { const b = atob(${safeJson(Buffer.from(data).toString('base64'))}); const a = new Uint8Array(b.length); for (let i = 0; i < b.length; i += 1) a[i] = b.charCodeAt(i); window.__mimikyuWebSocket?.send(a); })()`
                : `window.__mimikyuWebSocket?.send(${safeJson(String(data))})`;
            return Runtime.evaluate({ expression: payload });
        },
        close() {
            closed = true;
            return Runtime.evaluate({ expression: 'window.__mimikyuWebSocket?.close()' }).catch(() => {});
        },
    };
}

async function captureResponse(target, { captureUrl, navigationUrl, navigationHtml, onHeaders, onChunk }) {
    const { Fetch, IO, Network, Page } = target.tab;
    let settled = false;
    let timer;

    try {
        return await new Promise((resolve, reject) => {
            const finish = (callback) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                callback();
            };

            timer = setTimeout(() => {
                finish(() => reject(new Error('Browser request timed out')));
            }, REQUEST_TIMEOUT_MS);
            timer.unref?.();

            Fetch.requestPaused(async (event) => {
                try {
                    if (settled) {
                        if (event.responseStatusCode == null) {
                            await Fetch.continueRequest({ requestId: event.requestId });
                        }
                        return;
                    }
                    if (event.responseErrorReason) {
                        await Fetch.failRequest({
                            requestId: event.requestId,
                            errorReason: event.responseErrorReason,
                        }).catch(() => {});
                        finish(() => reject(new Error(`${event.responseErrorReason} at ${event.request?.url || 'unknown URL'}`)));
                        return;
                    }
                    if (event.responseStatusCode == null) {
                        const requestHeaders = event.request?.headers || {};
                        const requestedMethod = headerValue(requestHeaders, 'access-control-request-method');
                        if (event.request?.method === 'OPTIONS' && requestedMethod !== '') {
                            const origin = headerValue(requestHeaders, 'origin') || '*';
                            const requestedHeaders = headerValue(requestHeaders, 'access-control-request-headers');
                            const preflightHeaders = [
                                { name: 'Access-Control-Allow-Origin', value: origin },
                                { name: 'Access-Control-Allow-Methods', value: requestedMethod },
                                { name: 'Access-Control-Allow-Credentials', value: 'true' },
                                { name: 'Access-Control-Max-Age', value: '0' },
                                { name: 'Content-Length', value: '0' },
                            ];
                            if (requestedHeaders !== '') {
                                preflightHeaders.push({ name: 'Access-Control-Allow-Headers', value: requestedHeaders });
                            }
                            await Fetch.fulfillRequest({
                                requestId: event.requestId,
                                responseCode: 204,
                                responseHeaders: preflightHeaders,
                                body: '',
                            });
                            return;
                        }
                        await Fetch.continueRequest({ requestId: event.requestId });
                        return;
                    }

                    if (
                        navigationHtml !== undefined &&
                        event.request?.url === navigationUrl &&
                        event.request.url !== captureUrl
                    ) {
                        const htmlBody = Buffer.from(navigationHtml);
                        await Fetch.fulfillRequest({
                            requestId: event.requestId,
                            responseCode: 200,
                            responseHeaders: [
                                { name: 'Content-Type', value: 'text/html; charset=utf-8' },
                                { name: 'Content-Length', value: String(htmlBody.length) },
                            ],
                            body: htmlBody.toString('base64'),
                        });
                        return;
                    }

                    const responseInfo = {
                        statusCode: event.responseStatusCode,
                        headers: responseHeadersToObject(event.responseHeaders),
                    };
                    onHeaders?.(responseInfo);
                    const body = await readResponseBody(Fetch, IO, Network, event, onChunk);
                    const response = {
                        ...responseInfo,
                        body,
                    };
                    await Fetch.fulfillRequest({
                        requestId: event.requestId,
                        responseCode: response.statusCode,
                        responseHeaders: responseHeadersToFulfill(event.responseHeaders, body),
                        body: body.toString('base64'),
                    });
                    finish(() => resolve(response));
                } catch (error) {
                    finish(() => reject(error));
                }
            });

            (async () => {
                try {
                    const patterns = [
                        { urlPattern: captureUrl, requestStage: 'Request' },
                        { urlPattern: captureUrl, requestStage: 'Response' },
                    ];
                    if (
                        navigationHtml !== undefined &&
                        navigationUrl !== captureUrl &&
                        /^https?:\/\//u.test(navigationUrl)
                    ) {
                        patterns.push({ urlPattern: navigationUrl, requestStage: 'Response' });
                    }
                    await Fetch.enable({ patterns });
                    await Network.enable().catch(() => {});
                    await Page.enable();
                    const navigation = await Page.navigate({
                        url: navigationUrl,
                        transitionType: 'other',
                    });
                    if (navigation?.errorText) {
                        finish(() => reject(new Error(navigation.errorText)));
                    }
                } catch (error) {
                    finish(() => reject(error));
                }
            })();
        });
    } finally {
        await Fetch.disable().catch(() => {});
    }
}

export async function executeNavigation(target, url, streamOptions = {}) {
    const captureUrl = captureUrlFor(url);
    return captureResponse(target, {
      captureUrl,
      navigationUrl: captureUrl,
      ...streamOptions,
    });
}

export async function executeFetch(target, { url, pageUrl, method, headers, body, ...streamOptions }) {
    const { generateFetchDocument } = await import('./fetch-generator.mjs');
    const document = generateFetchDocument({ url, method, headers, body });
    const documentUrl = `data:text/html;charset=utf-8,${encodeURIComponent(document)}`;
    const captureUrl = captureUrlFor(url);
    const navigationUrl = pageUrl && pageUrl !== captureUrl ? pageUrl : documentUrl;
    return captureResponse(target, {
      captureUrl,
      navigationUrl,
      navigationHtml: navigationUrl === documentUrl ? undefined : document,
      ...streamOptions,
    });
}

export async function executeResource(target, { url, pageUrl, destination, ...streamOptions }) {
    const { generateResourceDocument } = await import('./fetch-generator.mjs');
    const document = generateResourceDocument({ url, destination });
    const documentUrl = `data:text/html;charset=utf-8,${encodeURIComponent(document)}`;
    const captureUrl = captureUrlFor(url);
    const navigationUrl = pageUrl && pageUrl !== captureUrl ? pageUrl : documentUrl;
    return captureResponse(target, {
      captureUrl,
      navigationUrl,
      navigationHtml: navigationUrl === documentUrl ? undefined : document,
      ...streamOptions,
    });
}

export async function executeForm(target, { url, pageUrl, method, body, contentType, ...streamOptions }) {
    const { generateFormDocument } = await import('./fetch-generator.mjs');
    const document = generateFormDocument({ url, method, body, contentType });
    const documentUrl = `data:text/html;charset=utf-8,${encodeURIComponent(document)}`;
    const captureUrl = captureUrlFor(url);
    const navigationUrl = pageUrl && pageUrl !== captureUrl ? pageUrl : documentUrl;
    return captureResponse(target, {
      captureUrl,
      navigationUrl,
      navigationHtml: navigationUrl === documentUrl ? undefined : document,
      ...streamOptions,
    });
}
