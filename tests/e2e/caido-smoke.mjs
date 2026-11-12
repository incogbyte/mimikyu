import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { request } from 'node:http';

const base = process.env.MIMIKYU_CAIDO_URL || 'http://127.0.0.1:18080';
const packagePath = process.env.MIMIKYU_PACKAGE || './dist/plugin_package.zip';
const agentToken = process.env.MIMIKYU_E2E_TOKEN || 'change-this-development-token';
let token;
let pluginId;

async function waitFor(read) {
    let lastError;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
        try {
            return await read();
        } catch (error) {
            lastError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw lastError || new Error('Caido did not become ready');
}

async function graphql(query, variables = {}) {
    const response = await fetch(`${base}/graphql`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.errors, undefined, JSON.stringify(result.errors));
    return result.data;
}

async function loginAndSelectProject() {
    const auth = await waitFor(() => graphql(`
        mutation { loginAsGuest { token { accessToken } error { __typename } } }
    `));
    token = auth.loginAsGuest.token?.accessToken;
    assert(token, JSON.stringify(auth));

    const current = await graphql(`
        query { currentProject { project { id } } }
    `);
    let projectId = current.currentProject?.project?.id;
    if (!projectId) {
        const project = await graphql(`
            mutation ($input: CreateProjectInput!) {
              createProject(input: $input) { project { id } error { __typename } }
            }
        `, { input: { name: 'Mimikyu POC', temporary: true } });
        projectId = project.createProject.project?.id;
        assert(projectId, JSON.stringify(project));
    }

    const selected = await graphql(`
        mutation ($id: ID!) {
          selectProject(id: $id) { currentProject { project { id } } error { __typename } }
        }
    `, { id: projectId });
    assert.equal(selected.selectProject.currentProject.project.id, projectId);
}

async function installPackage() {
    const form = new FormData();
    form.set('operations', JSON.stringify({
        query: `mutation($input: InstallPluginPackageInput!) {
          installPluginPackage(input: $input) {
            package { plugins { __typename ... on PluginBackend { id } } }
            error { __typename }
          }
        }`,
        variables: { input: { source: { file: null }, force: true } },
    }));
    form.set('map', JSON.stringify({ 0: ['variables.input.source.file'] }));
    form.set('0', new Blob([await readFile(packagePath)]), 'plugin_package.zip');
    const response = await fetch(`${base}/graphql`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: form,
        signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json();
    assert.equal(result.errors, undefined, JSON.stringify(result));
    const plugin = result.data?.installPluginPackage.package?.plugins.find(
        (entry) => entry.__typename === 'PluginBackend',
    );
    assert(plugin, JSON.stringify(result));
    pluginId = plugin.id;
}

async function rpc(name, ...args) {
    const response = await fetch(`${base}/plugin/backend/${pluginId}/function`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name, args: args.map((arg) => JSON.stringify(arg)) }),
        signal: AbortSignal.timeout(15_000),
    });
    assert.equal(response.status, 200);
    const raw = await response.json();
    assert.equal(raw.kind, 'success', JSON.stringify(raw));
    const result = JSON.parse(raw.returns);
    assert.equal(result.kind, 'Ok', JSON.stringify(result));
    return result.value;
}

async function createUpstreamRule() {
    const result = await graphql(`
        mutation ($input: CreateUpstreamPluginInput!) {
          createUpstreamPlugin(input: $input) { upstream { id enabled } }
        }
    `, {
        input: {
            pluginId,
            enabled: true,
            allowlist: ['*'],
            denylist: [],
        },
    });
    assert.equal(result.createUpstreamPlugin.upstream.enabled, true);
}

function proxyRequest() {
    return new Promise((resolve, reject) => {
        const clientRequest = request({
            host: '127.0.0.1',
            port: 18080,
            method: 'GET',
            path: 'http://origin:8080/navigation',
            headers: { Host: 'origin:8080' },
        }, (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => resolve({
                status: response.statusCode,
                body: Buffer.concat(chunks).toString('utf8'),
            }));
        });
        clientRequest.on('error', reject);
        clientRequest.setTimeout(30_000, () => clientRequest.destroy(new Error('Caido proxy request timed out')));
        clientRequest.end();
    });
}

await loginAndSelectProject();
await installPackage();
const settings = await rpc('getSettings');
await rpc('updateSettings', {
    ...settings,
    enabled: true,
    autoStart: true,
    agentHost: 'agent',
    agentPort: 38427,
    agentToken,
});
await createUpstreamRule();
await waitFor(async () => {
    const status = await rpc('getStatus');
    assert.equal(status.state, 'running');
    return status;
});

const response = await proxyRequest();
assert.equal(response.status, 200, response.body);
assert.match(response.body, /mimikyu-navigation-ok/u);
const activity = await rpc('getActivity');
assert.equal(activity.length, 1, JSON.stringify(activity));
assert.equal(activity[0].state, 'succeeded', JSON.stringify(activity));
assert.equal(activity[0].browserMode, 'docker-managed');

process.stdout.write('Mimikyu Caido integration smoke passed\n');
