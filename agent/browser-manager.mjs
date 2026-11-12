import { EventEmitter } from 'node:events';

import * as cdptransport from './cdptransport.mjs';

const CONNECT_TIMEOUT_MS = 5000;
const TARGET_TIMEOUT_MS = 5000;
const DEFAULT_MAX_TARGETS = 8;
const TARGET_QUEUE_TIMEOUT_MS = 10_000;

export class BrowserManager extends EventEmitter {
    constructor({ host, port }) {
        super();
        this.config = { host, port };
        this.browser = null;
        this.connecting = null;
        this.closed = false;
        this.maxTargets = Number(process.env.MIMIKYU_MAX_TARGETS || DEFAULT_MAX_TARGETS);
        if (!Number.isInteger(this.maxTargets) || this.maxTargets < 1) {
            this.maxTargets = DEFAULT_MAX_TARGETS;
        }
        this.activeTargets = 0;
        this.targetWaiters = [];
    }

    get connected() {
        return this.browser !== null;
    }

    async connect() {
        if (this.closed) {
            throw new Error('Browser manager is closed');
        }
        if (this.browser) {
            return this.browser;
        }
        if (this.connecting) {
            return this.connecting;
        }

        this.connecting = this.connectOnce();
        try {
            return await this.connecting;
        } finally {
            this.connecting = null;
        }
    }

    async connectOnce() {
        const browser = await cdptransport.connect(
            this.config,
            null,
            Date.now() + CONNECT_TIMEOUT_MS,
        );
        this.browser = browser;
        browser.once('disconnect', () => {
            if (this.browser !== browser) {
                return;
            }
            this.browser = null;
            this.emit('disconnected');
        });
        this.emit('connected');
        return browser;
    }

    async reconnect() {
        await this.closeBrowserConnection();
        return this.connect();
    }

    async acquireTarget({ cookieMode = 'shared' } = {}) {
        await this.acquireSlot();
        try {
            const browser = await this.connect();
            let browserContextId;
            if (cookieMode === 'isolated') {
                const context = await browser.Target.createBrowserContext({
                    disposeOnDetach: true,
                });
                browserContextId = context.browserContextId;
            }
            let result;
            try {
                result = await browser.Target.createTarget({
                    url: 'about:blank',
                    background: true,
                    hidden: true,
                    ...(browserContextId ? { browserContextId } : {}),
                });
            } catch (error) {
                if (!String(error).toLowerCase().includes('hidden')) throw error;
                result = await browser.Target.createTarget({
                    url: 'about:blank',
                    background: true,
                    ...(browserContextId ? { browserContextId } : {}),
                });
            }
            try {
                return await this.attachTarget(browser, result.targetId, browserContextId);
            } catch (error) {
                await browser.Target.closeTarget({ targetId: result.targetId }).catch(() => {});
                if (browserContextId) await browser.Target.disposeBrowserContext({ browserContextId }).catch(() => {});
                const fallback = await browser.Target.createTarget({
                    url: 'about:blank',
                    background: true,
                    ...(browserContextId ? { browserContextId } : {}),
                });
                try {
                    return await this.attachTarget(browser, fallback.targetId, browserContextId);
                } catch (fallbackError) {
                    await browser.Target.closeTarget({ targetId: fallback.targetId }).catch(() => {});
                    if (browserContextId) await browser.Target.disposeBrowserContext({ browserContextId }).catch(() => {});
                    throw fallbackError || error;
                }
            }
        } catch (error) {
            this.releaseSlot();
            throw error;
        }
    }

    async attachTarget(browser, targetId, browserContextId) {
        if (typeof targetId !== 'string' || targetId.length === 0) {
            throw new Error('Chrome returned an invalid target id');
        }
        const tab = await cdptransport.connect(
            this.config,
            targetId,
            Date.now() + TARGET_TIMEOUT_MS,
            browser.protocol,
        );
        return { browser, tab, targetId, browserContextId, slotReleased: false };
    }

    async releaseTarget(target) {
        if (!target) {
            return;
        }
        try {
            await cdptransport.close_session(target.tab, Date.now() + TARGET_TIMEOUT_MS);
            if (this.browser === target.browser) {
                await target.browser.Target.closeTarget({ targetId: target.targetId }).catch(() => {});
            }
            if (this.browser === target.browser && target.browserContextId) {
                await target.browser.Target.disposeBrowserContext({
                    browserContextId: target.browserContextId,
                }).catch(() => {});
            }
        } finally {
            if (!target.slotReleased) {
                target.slotReleased = true;
                this.releaseSlot();
            }
        }
    }

    async closeBrowserConnection() {
        const browser = this.browser;
        this.browser = null;
        if (browser) {
            await cdptransport.close_session(browser, Date.now() + TARGET_TIMEOUT_MS);
        }
    }

    async close() {
        this.closed = true;
        await this.closeBrowserConnection();
    }

    async acquireSlot() {
        if (this.activeTargets < this.maxTargets) {
            this.activeTargets += 1;
            return;
        }
        await new Promise((resolve, reject) => {
            const waiter = { resolve, reject };
            const timer = setTimeout(() => {
                const index = this.targetWaiters.indexOf(waiter);
                if (index >= 0) this.targetWaiters.splice(index, 1);
                reject(new Error('Browser target capacity queue timed out'));
            }, TARGET_QUEUE_TIMEOUT_MS);
            timer.unref?.();
            waiter.resolve = () => {
                clearTimeout(timer);
                resolve();
            };
            this.targetWaiters.push(waiter);
        });
    }

    releaseSlot() {
        const waiter = this.targetWaiters.shift();
        if (waiter) {
            waiter.resolve();
            return;
        }
        this.activeTargets = Math.max(0, this.activeTargets - 1);
    }
}
