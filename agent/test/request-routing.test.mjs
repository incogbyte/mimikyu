import test from 'node:test';
import assert from 'node:assert/strict';

import {
    generateFetchDocument,
    generateFormDocument,
    generateResourceDocument,
} from '../fetch-generator.mjs';
import {
    browserFetchHeaders,
    classifyRequest,
    getPageUrl,
} from '../request-classifier.mjs';

test('classifies document navigation separately from browser fetch', () => {
    assert.equal(classifyRequest({ method: 'GET', headers: {} }).kind, 'navigation');
    assert.equal(
        classifyRequest({ method: 'GET', headers: { 'sec-fetch-dest': 'empty' } }).kind,
        'fetch',
    );
    assert.equal(classifyRequest({ method: 'POST', headers: {} }).kind, 'fetch');
    assert.equal(
        classifyRequest({
            method: 'POST',
            headers: {
                'sec-fetch-dest': 'document',
                'sec-fetch-mode': 'navigate',
                'content-type': 'application/x-www-form-urlencoded',
            },
        }).kind,
        'form',
    );
    assert.equal(
        classifyRequest({ method: 'GET', headers: { 'sec-fetch-dest': 'image' } }).kind,
        'resource',
    );
});

test('removes browser-controlled headers from generated fetch options', () => {
    const headers = browserFetchHeaders({
        Cookie: 'session=secret',
        Host: 'example.test',
        Origin: 'https://example.test',
        'X-Request-ID': 'request-1',
    });
    assert.deepEqual(headers, { 'X-Request-ID': 'request-1' });
});

test('generates a safe browser fetch document with binary body support', () => {
    const document = generateFetchDocument({
        url: 'https://example.test/api?one=1&two=2',
        method: 'POST',
        headers: { 'X-Test': '<value>' },
        body: Buffer.from([0, 1, 2, 255]),
    });
    assert.match(document, /<script>/u);
    assert.match(document, /fetch\(/u);
    assert.match(document, /aGVsbG8|AAEC\/w==/u);
    assert.match(document, /\\u003cvalue\\u003e/u);
    assert.equal(
        getPageUrl('https://example.test/api', { Referer: 'https://example.test/page' }),
        'https://example.test/page',
    );
});

test('generates browser resource contexts', () => {
    const document = generateResourceDocument({
        url: 'https://example.test/image.png?a=1&b=2',
        destination: 'image',
    });
    assert.match(document, /<img[^>]+src="https:\/\/example\.test\/image\.png\?a=1&amp;b=2"/u);
});

test('generates urlencoded form documents', () => {
    const document = generateFormDocument({
        url: 'https://example.test/login',
        method: 'POST',
        contentType: 'application/x-www-form-urlencoded',
        body: Buffer.from('user=alice&scope=read'),
    });
    assert.match(document, /<form[^>]+method="post"/u);
    assert.match(document, /name="user" value="alice"/u);
    assert.match(document, /name="scope" value="read"/u);
});
