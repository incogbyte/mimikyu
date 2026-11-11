import { pathToFileURL } from 'node:url';

const hooks = new Map();

async function loadHook(filePath) {
    if (!filePath) return null;
    if (!hooks.has(filePath)) {
        const module = await import(pathToFileURL(filePath).href);
        if (typeof module.hook !== 'function') {
            throw new Error(`Hook does not export async hook: ${filePath}`);
        }
        hooks.set(filePath, module.hook);
    }
    return hooks.get(filePath);
}

export function hookLogger(phase) {
    const write = (level, message) => {
        process.stdout.write(`${JSON.stringify({ event: 'hook', phase, level, message: String(message) })}\n`);
    };
    return {
        debug: (message) => write('debug', message),
        info: (message) => write('info', message),
        warn: (message) => write('warn', message),
        error: (message) => write('error', message),
    };
}

export async function runOnStartHook(filePath, browser) {
    const hook = await loadHook(filePath);
    if (!hook) return;
    await hook(browser, null, null, hookLogger('on-start'));
}

export async function runBeforeHook(filePath, target, request) {
    const hook = await loadHook(filePath);
    if (!hook) return;
    await hook(target.tab, request, null, hookLogger('before-request'));
}

export async function runAfterHook(filePath, target, request, response) {
    const hook = await loadHook(filePath);
    if (!hook) return;
    await hook(target.tab, request, response, hookLogger('after-request'));
}
