const BROWSER_CONTROLLED_HEADERS = new Set([
    'accept',
    'accept-encoding',
    'accept-language',
    'cache-control',
    'connection',
    'content-length',
    'cookie',
    'host',
    'origin',
    'pragma',
    'priority',
    'referer',
    'sec-ch-ua',
    'sec-ch-ua-arch',
    'sec-ch-ua-bitness',
    'sec-ch-ua-full-version',
    'sec-ch-ua-full-version-list',
    'sec-ch-ua-mobile',
    'sec-ch-ua-model',
    'sec-ch-ua-platform',
    'sec-ch-ua-platform-version',
    'sec-fetch-dest',
    'sec-fetch-mode',
    'sec-fetch-site',
    'sec-fetch-user',
    'te',
    'upgrade-insecure-requests',
    'user-agent',
    'proxy-authorization',
    'proxy-connection',
]);

const SUPPORTED_RESOURCE_DESTINATIONS = new Set([
    'audio',
    'font',
    'frame',
    'iframe',
    'image',
    'manifest',
    'object',
    'script',
    'style',
    'track',
    'video',
    'worker',
]);

export function getHeader(headers, name) {
    const target = name.toLowerCase();
    for (const [key, value] of Object.entries(headers || {})) {
        if (key.toLowerCase() === target) {
            return Array.isArray(value) ? value[0] : value;
        }
    }
    return undefined;
}

export function getPageUrl(url, headers) {
    const referer = getHeader(headers, 'referer');
    if (typeof referer === 'string' && /^https?:\/\//u.test(referer)) {
        return referer;
    }

    const origin = getHeader(headers, 'origin');
    if (typeof origin === 'string' && /^https?:\/\//u.test(origin)) {
        return `${origin}/`;
    }

    try {
        return `${new URL(url).origin}/`;
    } catch {
        return 'about:blank';
    }
}

export function browserFetchHeaders(headers) {
    const result = {};
    for (const [key, value] of Object.entries(headers || {})) {
        const lower = key.toLowerCase();
        if (BROWSER_CONTROLLED_HEADERS.has(lower) || lower.startsWith('x-mimikyu-')) {
            continue;
        }
        result[key] = Array.isArray(value) ? value.join(', ') : String(value);
    }
    return result;
}

export function classifyRequest({ method, headers }) {
    const normalizedMethod = String(method || 'GET').toUpperCase();
    const destination = String(getHeader(headers, 'sec-fetch-dest') || '').toLowerCase();

    if (destination && destination !== 'empty' && destination !== 'document') {
        return SUPPORTED_RESOURCE_DESTINATIONS.has(destination)
            ? { kind: 'resource', destination }
            : { kind: 'unsupported-resource', destination };
    }
    if (
        destination === 'document' &&
        normalizedMethod !== 'GET' &&
        normalizedMethod !== 'HEAD' &&
        String(getHeader(headers, 'sec-fetch-mode') || '').toLowerCase() === 'navigate' &&
        String(getHeader(headers, 'content-type') || '')
            .toLowerCase()
            .startsWith('application/x-www-form-urlencoded')
    ) {
        return { kind: 'form' };
    }
    if (normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD') {
        return { kind: 'fetch' };
    }
    if (destination === 'empty') {
        return { kind: 'fetch' };
    }

    return { kind: 'navigation' };
}
