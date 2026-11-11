import { randomBytes } from 'node:crypto';

import { BrowserManager } from './browser-manager.mjs';
import { createRelay } from './relay.mjs';
import { runOnStartHook } from './hook-runner.mjs';

const VERSION = '0.1.0';
const host = process.env.MIMIKYU_AGENT_HOST || '127.0.0.1';
const port = Number(process.env.MIMIKYU_AGENT_PORT || 0);
const token = process.env.MIMIKYU_TOKEN || randomBytes(32).toString('hex');
const browserManager = new BrowserManager({
    host: process.env.CHROME_DEBUGGING_HOST || '127.0.0.1',
    port: Number(process.env.CHROME_DEBUGGING_PORT || 9222),
});
const onStartHookPath = process.env.ON_START_HOOK_FILE_PATH;
let startHookDone = onStartHookPath === undefined;
const relay = createRelay({
    token,
    browserManager,
    host,
    port,
    beforeHookPath: process.env.BEFORE_REQUEST_HOOK_FILE_PATH,
    afterHookPath: process.env.AFTER_REQUEST_HOOK_FILE_PATH,
    isReady: () => browserManager.connected && startHookDone,
    onRequest: (event) => writeEvent({ event: 'request', ...event }),
});
const RECONNECT_DELAY_MS = 5000;
let reconnectTimer;

function writeEvent(event) {
    process.stdout.write(`${JSON.stringify(event)}\n`);
}

function scheduleBrowserReconnect() {
    if (reconnectTimer !== undefined || browserManager.connected) return;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        connectBrowser().catch(() => scheduleBrowserReconnect());
    }, RECONNECT_DELAY_MS);
    reconnectTimer.unref?.();
}

async function connectBrowser() {
    const browser = await browserManager.connect();
    if (startHookDone) return;
    try {
        await runOnStartHook(onStartHookPath, browser);
        startHookDone = true;
        writeEvent({ event: 'hook', phase: 'on-start', state: 'completed' });
    } catch (error) {
        writeEvent({ event: 'hook', phase: 'on-start', state: 'failed', error: String(error) });
        await browserManager.closeBrowserConnection();
        throw error;
    }
}

async function shutdown(signal) {
    writeEvent({ event: 'shutdown', signal });
    if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
    await relay.close().catch(() => {});
    await browserManager.close().catch(() => {});
    process.exit(0);
}

browserManager.on('connected', () => writeEvent({ event: 'browser', state: 'connected' }));
browserManager.on('disconnected', () => {
    writeEvent({ event: 'browser', state: 'disconnected' });
    scheduleBrowserReconnect();
});

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => void shutdown(signal));
}

const address = await relay.listen();
writeEvent({
    event: 'ready',
    port: address.port,
    version: VERSION,
    token,
});

connectBrowser().catch((error) => {
    writeEvent({ event: 'browser', state: 'unavailable', error: String(error) });
    scheduleBrowserReconnect();
});
