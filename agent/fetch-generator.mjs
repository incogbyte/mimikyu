function safeJson(value) {
    return JSON.stringify(value)
        .replaceAll('<', '\\u003c')
        .replaceAll('>', '\\u003e')
        .replaceAll('&', '\\u0026');
}

function pageTemplate(body) {
    return `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;
}

function htmlAttribute(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('"', '&quot;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
}

export function generateResourceDocument({ url, destination }) {
    const target = htmlAttribute(url);
    let element;
    switch (destination) {
        case 'audio':
            element = `<audio src="${target}" autoplay></audio>`;
            break;
        case 'font':
            element = `<style>@font-face{font-family:MimikyuFont;src:url("${target}")}body{font-family:MimikyuFont}</style><p>resource</p>`;
            break;
        case 'frame':
        case 'iframe':
            element = `<iframe src="${target}" sandbox></iframe>`;
            break;
        case 'image':
            element = `<img src="${target}" alt="resource">`;
            break;
        case 'manifest':
            element = `<link rel="manifest" href="${target}">`;
            break;
        case 'object':
            element = `<object data="${target}" type="application/octet-stream"></object>`;
            break;
        case 'script':
            element = `<link rel="preload" href="${target}" as="script">`;
            break;
        case 'style':
            element = `<link rel="stylesheet" href="${target}">`;
            break;
        case 'track':
            element = `<video controls><track src="${target}" kind="subtitles"></video>`;
            break;
        case 'video':
            element = `<video src="${target}" autoplay></video>`;
            break;
        case 'worker':
            element = `<script>new Worker(${safeJson(url)});</script>`;
            break;
        default:
            throw new Error(`Unsupported resource destination: ${destination}`);
    }
    return pageTemplate(element);
}

export function generateFormDocument({ url, method, body, contentType }) {
    if (method.toUpperCase() !== 'GET' && method.toUpperCase() !== 'POST') {
        throw new Error(`HTML forms do not support ${method}`);
    }
    if (contentType && contentType.toLowerCase().startsWith('multipart/form-data')) {
        throw new Error('Multipart form submission is not implemented yet');
    }
    const fields = new URLSearchParams(body?.toString('utf8') || '');
    const inputs = [];
    for (const [name, value] of fields.entries()) {
        inputs.push(`<input type="hidden" name="${htmlAttribute(name)}" value="${htmlAttribute(value)}">`);
    }
    const form = `<form id="mimikyu-form" action="${htmlAttribute(url)}" method="${method.toLowerCase()}">${inputs.join('')}</form><script>document.getElementById('mimikyu-form').submit();</script>`;
    return pageTemplate(form);
}

export function generateFetchDocument({ url, method, headers, body }) {
    const bodyBase64 = body && body.length > 0 ? body.toString('base64') : '';
    const bodyCode = bodyBase64 === ''
        ? ''
        : `const encoded = ${safeJson(bodyBase64)};
const binary = atob(encoded);
const bytes = new Uint8Array(binary.length);
for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
options.body = bytes.buffer;`;
    const script = `
<script>
(async () => {
    const options = ${safeJson({ method, headers })};
    ${bodyCode}
    try {
        await fetch(${safeJson(url)}, options);
    } catch (error) {
        console.error('Mimikyu fetch execution failed', error);
    }
})();
</script>`;
    return pageTemplate(script);
}
