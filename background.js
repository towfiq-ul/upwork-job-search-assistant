'use strict';

/* ──────────────────────────────────────────────────────────────────────────
 * Upwork Job Search Assistant — background service worker
 *
 * Auth approach (proven by the open-source "Upwork Toolkit" extension):
 *   1. Read all cookies scoped to path "/nx/find-work/" via chrome.cookies.
 *   2. Pick whichever cookie has the furthest-future expirationDate.
 *   3. If it's expired/missing, clear cookies for that path, then GET
 *      https://www.upwork.com/nx/find-work/ (with credentials) TWICE
 *      (5s apart) to force Upwork to mint fresh oauth2v2_int_* cookies.
 *   4. Use that cookie's value as `Authorization: bearer <value>`.
 *   5. NO x-upwork-api-tenantid header — it's not needed and causes errors.
 *   6. Origin/Referer can't be set via fetch (forbidden headers), so a
 *      declarativeNetRequest rule (request_modifier.json) injects them
 *      at the network layer for requests to /api/graphql/v1.
 *
 * This requires NO content script and NO open Upwork tab — the background
 * service worker does everything itself via fetch + chrome.cookies.
 * ────────────────────────────────────────────────────────────────────────*/

const GQL_URL = 'https://www.upwork.com/api/graphql/v1';
const FIND_WORK_URL = 'https://www.upwork.com/nx/find-work/';
const COOKIE_PATH = '/nx/find-work/';

const POLL_ALARM = 'upwork_poll';
const POLL_MINUTES = 2;
const MAX_STORED = 500;

const PAGE_HEADERS = {
    'Cache-Control': 'no-cache',
    'Accept': [
        'text/html', 'application/xhtml+xml', 'application/xml;q=0.9',
        'image/avif', 'image/webp', 'image/apng', '*/*;q=0.8',
        'application/signed-exchange;v=b3;q=0.9',
    ].join(', '),
    'X-Requested-With': 'XMLHttpRequest',
};

// ── GraphQL queries ───────────────────────────────────────────────────────────
const QUERIES = {
    myFeed: {
        resultKey: 'userSavedSearches',
        variables: {queryParams: {}},
        query: `
      query($queryParams: UserSavedSearchesParams) {
        userSavedSearches(params: $queryParams) {
          results {
            id uid:id title ciphertext description type recno
            freelancersToHire duration durationLabel engagement
            amount { amount:displayValue }
            createdOn:createdDateTime publishedOn:publishedDateTime renewedOn:renewedDateTime
            prefFreelancerLocation prefFreelancerLocationMandatory connectPrice
            client {
              totalHires totalPostedJobs
              totalSpent { rawValue currency displayValue }
              paymentVerificationStatus
              location { country }
              totalReviews totalFeedback companyRid edcUserId lastContractRid companyOrgUid hasFinancialPrivacy
            }
            enterpriseJob premium jobTs:jobTime
            skills { id name prettyName highlighted }
            contractorTier jobStatus relevanceEncoded totalApplicants proposalsTier
            isLocal:local
            locations { city country }
            isApplied:applied
            attrs { id uid:id prettyName:prefLabel parentSkillId prefLabel highlighted freeText }
            hourlyBudget { type min max }
            clientRelation { companyRid companyName edcUserId lastContractPlatform lastContractRid lastContractTitle }
            totalFreelancersToHire contractToHire
          }
          paging { total count resultSetTs:resultSetTime }
        }
      }
    `,
    },

    bestMatches: {
        resultKey: 'bestMatchJobsFeed',
        variables: {fromTime: 0, toTime: 30},
        query: `
      query bestMatches {
        bestMatchJobsFeed(limit: 30) {
          results {
            uid:id title ciphertext description type recno
            freelancersToHire duration durationLabel engagement
            amount { amount currencyCode }
            createdOn:createdDateTime publishedOn:publishedDateTime renewedOn:renewedDateTime
            prefFreelancerLocation prefFreelancerLocationMandatory connectPrice
            client {
              totalHires totalSpent paymentVerificationStatus
              location { country city state countryTimezone worldRegion }
              totalReviews totalFeedback hasFinancialPrivacy
            }
            enterpriseJob premium jobTime
            skills { id prefLabel }
            tierText tier tierLabel proposalsTier isApplied
            hourlyBudget { type min max }
            weeklyBudget { amount }
            clientRelation { companyName lastContractRid lastContractTitle }
            relevanceEncoded
            attrs { uid:id prettyName freeText skillType }
          }
          paging { total count minTime maxTime }
        }
      }
    `,
    },

    mostRecent: {
        resultKey: 'mostRecentJobsFeed',
        variables: {limit: 50},
        query: `
      query($limit: Int, $toTime: String) {
        mostRecentJobsFeed(limit: $limit, toTime: $toTime) {
          results {
            id uid:id title ciphertext description type recno
            freelancersToHire duration engagement
            amount { amount }
            createdOn:createdDateTime publishedOn:publishedDateTime
            prefFreelancerLocationMandatory connectPrice
            client {
              totalHires totalSpent paymentVerificationStatus
              location { country }
              totalReviews totalFeedback hasFinancialPrivacy
            }
            tierText tier tierLabel proposalsTier enterpriseJob premium
            jobTs:jobTime
            attrs:skills { id uid:id prettyName:prefLabel prefLabel }
            hourlyBudget { type min max }
            isApplied
          }
          paging { total count resultSetTs:minTime maxTime }
        }
      }
    `,
    },
};

// ── In-memory state (hydrated from storage on boot) ───────────────────────────
let knownIds = new Set();
let storedJobs = [];
let enabled = true;
let newJobCount = 0;
let lastErrorType = '';
let lastErrorMsg = '';
let lastPollTime = 0;
let isPolling = false;
let stateLoaded = false;
let stateLoadingPromise = null;

// ── Boot ──────────────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);

async function init() {
    await ensureStateLoaded();
    scheduleAlarm();
    updateBadge();
    if (enabled) poll();
}

// MV3 service workers can be killed and respawned just to handle a single
// event (e.g. an alarm) without onInstalled/onStartup firing first. Any
// entry point must call this before touching knownIds/storedJobs/etc.,
// otherwise a fresh worker would think every job is new and re-notify.
function ensureStateLoaded() {
    if (stateLoaded) return Promise.resolve();
    if (stateLoadingPromise) return stateLoadingPromise;

    stateLoadingPromise = (async () => {
        const data = await chrome.storage.local.get([
            'jobs', 'knownIds', 'enabled', 'newJobCount', 'lastErrorType', 'lastErrorMsg'
        ]);
        storedJobs = data.jobs || [];
        knownIds = new Set(data.knownIds || []);
        enabled = data.enabled !== false;
        newJobCount = data.newJobCount || 0;
        lastErrorType = data.lastErrorType || '';
        lastErrorMsg = data.lastErrorMsg || '';
        stateLoaded = true;
    })();

    return stateLoadingPromise;
}

function scheduleAlarm() {
    chrome.alarms.clearAll(() => {
        chrome.alarms.create(POLL_ALARM, {delayInMinutes: 0.05, periodInMinutes: POLL_MINUTES});
    });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== POLL_ALARM) return;
    await ensureStateLoaded();
    if (enabled) poll();
});

// ── Messages from popup ───────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
        await ensureStateLoaded();

        switch (msg.action) {

            case 'getJobs':
                sendResponse({
                    jobs: storedJobs, enabled, newJobCount,
                    lastErrorType, lastErrorMsg, lastPollTime,
                });
                break;

            case 'clearNew':
                newJobCount = 0;
                await chrome.storage.local.set({newJobCount: 0});
                updateBadge();
                sendResponse({ok: true});
                break;

            case 'setEnabled':
                enabled = msg.value;
                await chrome.storage.local.set({enabled});
                updateBadge();
                if (enabled) poll();
                sendResponse({ok: true});
                break;

            case 'clearJobs':
                storedJobs = [];
                knownIds = new Set();
                newJobCount = 0;
                lastErrorType = '';
                lastErrorMsg = '';
                await chrome.storage.local.set({
                    jobs: [], knownIds: [], newJobCount: 0,
                    lastErrorType: '', lastErrorMsg: '',
                    notificationJobIds: [],
                });
                updateBadge();
                sendResponse({ok: true});
                break;

            case 'pollNow':
                await poll();
                sendResponse({ok: true});
                break;
        }
    })();
    return true;
});

// ── Cookie-token retrieval ────────────────────────────────────────────────────
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getCookieToken(shouldTryAgain = true) {
    const cookies = await chrome.cookies.getAll({path: COOKIE_PATH});

    const cookie = cookies.length
        ? cookies.reduce((best, cur) =>
            (cur.expirationDate || 0) > (best.expirationDate || 0) ? cur : best)
        : null;

    if (cookie && cookie.expirationDate && cookie.expirationDate * 1000 > Date.now()) {
        return cookie;
    }

    if (!shouldTryAgain) return null;

    await removeCookiesForPath();
    await triggerFindWorkPage();
    await sleep(5000);
    await triggerFindWorkPage();

    return getCookieToken(false);
}

async function removeCookiesForPath() {
    const cookies = await chrome.cookies.getAll({path: COOKIE_PATH});
    await Promise.all(
        cookies.map((c) =>
            chrome.cookies.remove({name: c.name, url: `https://upwork.com${c.path}`})
        )
    );
}

async function triggerFindWorkPage() {
    try {
        return await fetch(FIND_WORK_URL, {credentials: 'include', headers: PAGE_HEADERS});
    } catch {
        return null;
    }
}

// ── GraphQL request ───────────────────────────────────────────────────────────
async function requestJobsViaApi(token, feedType) {
    const q = QUERIES[feedType];
    if (!q) throw new Error(`Unknown feed type: ${feedType}`);

    const headers = {'Content-Type': 'application/json'};
    if (token) headers['Authorization'] = `bearer ${token}`;
    if (feedType === 'mostRecent') headers['X-Requested-With'] = 'XMLHttpRequest';

    let res;
    try {
        res = await fetch(GQL_URL, {
            method: 'POST',
            credentials: 'include',
            headers,
            body: JSON.stringify({query: q.query, variables: q.variables}),
        });
    } catch (e) {
        const err = new Error('Network error: ' + e.message);
        err.type = 'NETWORK_ERROR';
        throw err;
    }

    if (res.status === 401) {
        const err = new Error('Unauthenticated (401)');
        err.status = 401;
        err.type = 'UNAUTHENTICATED';
        throw err;
    }

    let data;
    try {
        data = await res.json();
    } catch {
        const err = new Error(`Bad response (HTTP ${res.status})`);
        err.status = res.status;
        throw err;
    }

    if (data.errors) {
        const msg = data.errors[0]?.message || 'GraphQL error';
        const err = new Error(msg);
        err.status = res.status;
        if (/oauth2 permission/i.test(msg)) err.type = 'UNAUTHENTICATED';
        throw err;
    }

    if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        if (res.status === 403 || res.status === 429) err.type = 'FORBIDDEN';
        else if (res.status >= 500) err.type = 'SERVER_ERROR';
        throw err;
    }

    const results = data?.data?.[q.resultKey]?.results;
    return Array.isArray(results) ? results.map(normalizeJob) : [];
}

function isUnauthenticatedError(error) {
    return error?.type === 'UNAUTHENTICATED' || error?.status === 401;
}

async function getJobsForFeed(feedType) {
    const cookie = await getCookieToken();

    if (!cookie) {
        const err = new Error('Not logged in to Upwork');
        err.type = 'UNAUTHENTICATED';
        throw err;
    }

    try {
        return await requestJobsViaApi(cookie.value, feedType);
    } catch (error) {
        if (isUnauthenticatedError(error)) {
            await removeCookiesForPath();
            const fresh = await getCookieToken();
            if (!fresh) {
                const err = new Error('Not logged in to Upwork');
                err.type = 'UNAUTHENTICATED';
                throw err;
            }
            return await requestJobsViaApi(fresh.value, feedType);
        }
        throw error;
    }
}

// ── Normalize job data ────────────────────────────────────────────────────────
function normalizeJob(raw) {
    const id = raw.ciphertext || '';

    let timestamp = 0;
    if (raw.jobTs) timestamp = parseInt(raw.jobTs, 10);
    else if (raw.jobTime) timestamp = parseInt(raw.jobTime, 10);
    else if (raw.createdOn) timestamp = Date.parse(raw.createdOn) || 0;

    let budget = '';
    const hr = raw.hourlyBudget;
    if (hr && hr.type && hr.type !== 'NotProvided' && (hr.min || hr.max)) {
        budget = `$${hr.min}–$${hr.max}/hr`;
    } else if (raw.amount && raw.amount.amount) {
        const amt = raw.amount.amount;
        budget = typeof amt === 'string' && amt.startsWith('$') ? amt : `$${amt}`;
    }

    let jobType = '';
    if (raw.type === 'FIXED' || raw.type === 1) jobType = 'Fixed';
    else if (raw.type === 'HOURLY' || raw.type === 2) jobType = 'Hourly';

    const skillSource = raw.attrs || raw.skills || [];
    const skills = skillSource
        .map((s) => s.prettyName || s.prefLabel || s.name || '')
        .filter(Boolean);

    return {
        id,
        title: raw.title || '(Untitled)',
        url: id ? `https://www.upwork.com/jobs/${id}` : '',
        timestamp,
        budget,
        jobType,
        skills,
        tier: raw.tierText || raw.tier || raw.contractorTier || '',
        proposals: raw.proposalsTier || '',
        country: raw.client?.location?.country || '',
        description: (raw.description || '').substring(0, 300),
        isApplied: !!(raw.isApplied),
    };
}

// ── Core poll cycle ───────────────────────────────────────────────────────────
async function poll() {
    await ensureStateLoaded();
    if (isPolling) return;
    isPolling = true;

    try {
        const settings = await chrome.storage.local.get(['feedType', 'timeDays']);
        const feedType = settings.feedType || 'mostRecent';
        const days = parseFloat(settings.timeDays || '7');
        const cutoff = days >= 9999 ? 0 : Date.now() - days * 24 * 60 * 60 * 1000;

        let jobs;
        try {
            jobs = await getJobsForFeed(feedType);
        } catch (error) {
            lastErrorType = error.type || 'OTHER';
            lastErrorMsg = (error.message || 'Unknown error').substring(0, 150);
            await chrome.storage.local.set({lastErrorType, lastErrorMsg});
            updateBadge();
            return;
        }

        lastErrorType = '';
        lastErrorMsg = '';

        const filtered = cutoff ? jobs.filter((j) => j.timestamp >= cutoff) : jobs;
        const brandNew = filtered.filter((j) => j.id && !knownIds.has(j.id));

        for (const job of filtered) {
            if (job.id && !knownIds.has(job.id)) {
                knownIds.add(job.id);
                storedJobs.unshift(job);
            }
        }

        storedJobs.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        if (storedJobs.length > MAX_STORED) storedJobs = storedJobs.slice(0, MAX_STORED);

        newJobCount += brandNew.length;
        lastPollTime = Date.now();

        await chrome.storage.local.set({
            jobs: storedJobs, knownIds: [...knownIds], newJobCount,
            lastErrorType: '', lastErrorMsg: '',
        });

        updateBadge();
        if (brandNew.length > 0) sendNotification(brandNew);

    } finally {
        isPolling = false;
    }
}

// ── Notifications ─────────────────────────────────────────────────────────────
const notificationJobs = new Map();
let notificationCounter = 0;

function sendNotification(newJobs) {
    const count = newJobs.length;
    const id = `upwork_jobs_${Date.now()}_${++notificationCounter}`;

    notificationJobs.set(id, newJobs);
    // Keep map bounded — only last 20 notifications need to be trackable
    if (notificationJobs.size > 20) {
        notificationJobs.delete(notificationJobs.keys().next().value);
    }

    // ── Save these IDs so jobs.html can split new vs previously seen ──────────
    // Replaces any prior batch; jobs.html always reflects the last notification.
    chrome.storage.local.set({
        notificationJobIds: newJobs.map((j) => j.id).filter(Boolean),
    });

    const title = count === 1 ? newJobs[0].title : `${count} new Upwork jobs`;
    const message = count === 1
        ? (newJobs[0].budget || newJobs[0].tier || 'Click to view')
        : newJobs.slice(0, 3).map((j) => `• ${j.title}`).join('\n');

    chrome.notifications.create(id, {
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: '🟢 Upwork — New Jobs',
        message: title,
        contextMessage: message,
        priority: 2,
    });
}

// ── Notification click → open jobs.html, reset badge ─────────────────────────
chrome.notifications.onClicked.addListener(async (notificationId) => {
    chrome.notifications.clear(notificationId);

    // Reset badge count immediately
    await ensureStateLoaded();
    newJobCount = 0;
    await chrome.storage.local.set({newJobCount: 0});
    updateBadge();

    // Open the custom jobs page (always — no raw Upwork URLs)
    chrome.tabs.create({url: chrome.runtime.getURL('jobs.html')});
});

// ── Badge ──────────────────────────────────────────────────────────────────────
function updateBadge() {
    if (!enabled) {
        chrome.action.setBadgeText({text: 'OFF'});
        chrome.action.setBadgeBackgroundColor({color: '#555'});
        return;
    }
    if (lastErrorType === 'UNAUTHENTICATED') {
        chrome.action.setBadgeText({text: '!'});
        chrome.action.setBadgeBackgroundColor({color: '#f85149'});
        return;
    }
    if (newJobCount > 0) {
        chrome.action.setBadgeText({text: newJobCount > 99 ? '99+' : String(newJobCount)});
        chrome.action.setBadgeBackgroundColor({color: '#14a800'});
    } else {
        chrome.action.setBadgeText({text: ''});
    }
}
