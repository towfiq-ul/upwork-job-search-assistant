'use strict';

// Content script: reads the tenant ID from cookies and sends to background.
// No auth token needed — the API uses browser session cookies automatically.

function readCookie(name) {
    const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return match ? decodeURIComponent(match[1]) : null;
}

function sendCredentials() {
    const tenantId = readCookie('current_organization_uid');
    const userId   = readCookie('user_uid');

    if (tenantId || userId) {
        chrome.runtime.sendMessage({
            action: 'setCredentials',
            tenantId: tenantId || '',
            userId:   userId   || '',
        });
    }
}

sendCredentials();

// Re-run on SPA navigation
let lastUrl = location.href;
new MutationObserver(() => {
    if (location.href !== lastUrl) {
        lastUrl = location.href;
        setTimeout(sendCredentials, 1000);
    }
}).observe(document.body, { childList: true, subtree: true });