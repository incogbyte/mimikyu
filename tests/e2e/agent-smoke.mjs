import assert from 'node:assert/strict';
import { request } from 'node:http';

const agentHost = process.env.MIMIKYU_E2E_AGENT_HOST || '127.0.0.1';
const agentPort = Number(process.env.MIMIKYU_E2E_AGENT_PORT || 38427);
const token = process.env.MIMIKYU_E2E_TOKEN || 'change-this-development-token';

function callAgent({ method = 'GET', path, host = 'origin', port = 8080, headers = {}, body = '' }) {
    return new Promise((resolve, reject) => {
        const requestHeaders = {
            'X-Mimikyu-Token': token,
            'X-Mimikyu-Scheme': 'http',
            'X-Mimikyu-Host': host,
            'X-Mimikyu-Port': String(port),
            'X-Mimikyu-Trace': `e2e-${Math.random().toString(36).slice(2)}`,
            'X-Mimikyu-Max-Body-Bytes': String(8 * 1024 * 1024),
            ...headers,
        };
        const clientRequest = request({
            host: agentHost,
            port: agentPort,
            method,
            path,
            headers: requestHeaders,
        }, (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => resolve({
                status: response.statusCode,
                headers: response.headers,
                body: Buffer.concat(chunks),
            }));
        });
        clientRequest.on('error', reject);
        clientRequest.end(body);
    });
}

async function waitForAgent() {
    for (let attempt = 0; attempt < 60; attempt += 1) {
        try {
            const response = await new Promise((resolve, reject) => {
                const probe = request({ host: agentHost, port: agentPort, path: '/health' }, (result) => {
                    result.resume();
                    result.once('end', () => resolve(result.statusCode));
                });
                probe.on('error', reject);
                probe.end();
            });
            if (response === 200) return;
        } catch {
            // The Compose stack may still be starting.
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error('Mimikyu agent did not become healthy');
}

await waitForAgent();

const navigation = await callAgent({ path: '/navigation' });
assert.equal(navigation.status, 200);
assert.match(navigation.body.toString('utf8'), /mimikyu-navigation-ok/u);

const fetchResponse = await callAgent({
    method: 'POST',
    path: '/api/echo',
    headers: {
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Content-Type': 'application/json',
        Origin: 'http://origin:8080',
    },
    body: JSON.stringify({ hello: 'mimikyu' }),
});
assert.equal(fetchResponse.status, 200);
const fetchPayload = JSON.parse(fetchResponse.body.toString('utf8'));
assert.equal(fetchPayload.path, '/api/echo');
assert.equal(fetchPayload.method, 'POST');
assert.equal(fetchPayload.body, JSON.stringify({ hello: 'mimikyu' }));

const resource = await callAgent({
    path: '/image',
    headers: { 'Sec-Fetch-Dest': 'image' },
});
assert.equal(resource.status, 200);
assert.equal(resource.headers['content-type'], 'image/png');

const form = await callAgent({
    method: 'POST',
    path: '/form',
    headers: {
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'user=alice&scope=read',
});
assert.equal(form.status, 200);
const formPayload = JSON.parse(form.body.toString('utf8'));
assert.equal(formPayload.path, '/form');
assert.equal(formPayload.method, 'POST');
assert.equal(formPayload.body, 'user=alice&scope=read');

const cookie = await callAgent({
    path: '/api/echo',
    headers: { Cookie: 'mimikyu_cookie=from-caido' },
});
assert.equal(cookie.status, 200);
const cookiePayload = JSON.parse(cookie.body.toString('utf8'));
assert.match(cookiePayload.headers.cookie, /mimikyu_cookie=from-caido/u);

const isolatedCookie = await callAgent({
    path: '/api/echo',
    headers: { 'X-Mimikyu-Cookie-Mode': 'isolated' },
});
assert.equal(isolatedCookie.status, 200);
const isolatedPayload = JSON.parse(isolatedCookie.body.toString('utf8'));
assert.equal(isolatedPayload.headers.cookie, '');

const clonedCookie = await callAgent({
    path: '/api/echo',
    headers: { 'X-Mimikyu-Cookie-Mode': 'isolated-cloned' },
});
assert.equal(clonedCookie.status, 200);
const clonedPayload = JSON.parse(clonedCookie.body.toString('utf8'));
assert.match(clonedPayload.headers.cookie, /mimikyu_cookie=from-caido/u);

process.stdout.write('Mimikyu agent E2E smoke passed\n');
