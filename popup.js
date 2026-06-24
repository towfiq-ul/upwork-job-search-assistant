'use strict';

/* ──────────────────────────────────────────────────────────────────────────
 * Upwork Job Search Assistant — popup controller
 *
 * Runs in the popup page context. Communicates with background.js via
 * chrome.runtime.sendMessage. Does NOT contain any service worker code.
 * ────────────────────────────────────────────────────────────────────────*/

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const elFeedType = $('feed-type');
const elTimeFilter = $('time-filter');
const elTypeHourly = $('type-hourly');
const elTypeFixed = $('type-fixed');
const elSkillsInput = $('skills-input');
const elBtnFilter = $('btn-filter');
const elBtnViewAll = $('btn-view-all');
const elBtnClear = $('btn-clear');
const elBtnRefresh = $('btn-refresh');
const elEnableToggle = $('enable-toggle');
const elToggleLabel = $('toggle-label');
const elStatusBar = $('status-bar');
const elJobsList = $('jobs-list');
const elAuthBanner = $('auth-banner');
const elAuthTitle = $('auth-title');
const elAuthText = $('auth-text');
const elAuthBtn = $('auth-btn');
const elFeedHint = $('feed-hint');
const elDisabledOverlay = $('disabled-overlay');

// ── State ─────────────────────────────────────────────────────────────────────
let allJobs = [];
let activeSkills = []; // parsed for skill tag highlighting

const FEED_HINTS = {
    mostRecent: 'Newest jobs sorted by post time — no Upwork-side setup needed.',
    bestMatches: 'Upwork\'s AI-matched jobs based on your profile.',
    myFeed: 'Jobs from your saved searches on Upwork.',
};

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
    // Restore saved filter settings so popup opens with previous state
    const saved = await chrome.storage.local.get([
        'feedType', 'timeDays', 'skillsFilter', 'typeHourly', 'typeFixed',
    ]);

    if (saved.feedType != null) elFeedType.value = saved.feedType;
    if (saved.timeDays != null) elTimeFilter.value = saved.timeDays;
    if (saved.skillsFilter != null) elSkillsInput.value = saved.skillsFilter;
    if (saved.typeHourly != null) elTypeHourly.checked = !!saved.typeHourly;
    if (saved.typeFixed != null) elTypeFixed.checked = !!saved.typeFixed;

    updateFeedHint();
    await loadAndRender();
}

// ── Load jobs from background and update all UI ───────────────────────────────
async function loadAndRender() {
    setStatus('loading', 'Loading…');

    let resp;
    try {
        resp = await chrome.runtime.sendMessage({action: 'getJobs'});
    } catch {
        setStatus('error', 'Cannot reach background service — try reloading.');
        return;
    }

    allJobs = resp.jobs || [];

    // Sync toggle state
    elEnableToggle.checked = resp.enabled;
    elToggleLabel.textContent = resp.enabled ? 'ON' : 'OFF';
    elDisabledOverlay.classList.toggle('show', !resp.enabled);

    // Auth / error banner
    if (resp.lastErrorType === 'UNAUTHENTICATED') {
        showAuthBanner('error');
        setStatus('error', 'Not logged in to Upwork');
    } else if (resp.lastErrorType) {
        hideAuthBanner();
        setStatus('warn', resp.lastErrorMsg || 'Error fetching jobs');
    } else if (resp.lastPollTime) {
        hideAuthBanner();
        const agoSec = Math.round((Date.now() - resp.lastPollTime) / 1000);
        const agoStr = agoSec < 60 ? `${agoSec}s ago` : `${Math.round(agoSec / 60)}m ago`;
        const visible = applyFilters(allJobs).length;
        setStatus('success', `${visible} job${visible !== 1 ? 's' : ''} · polled ${agoStr}`);
    } else {
        hideAuthBanner();
        setStatus('loading', 'Waiting for first poll…');
    }

    // Clear badge counter (user opened popup = they've seen the count)
    if (resp.newJobCount > 0) {
        chrome.runtime.sendMessage({action: 'clearNew'});
    }

    renderJobs();
}

// ── Filtering ─────────────────────────────────────────────────────────────────
function getFilters() {
    return {
        timeDays: parseFloat(elTimeFilter.value || '7'),
        skills: elSkillsInput.value,
        typeHourly: elTypeHourly.checked,
        typeFixed: elTypeFixed.checked,
    };
}

function applyFilters(jobs) {
    const f = getFilters();
    const skills = f.skills.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const cutoff = f.timeDays >= 9999 ? 0 : Date.now() - f.timeDays * 86400000;

    // Expose to renderer so matched skill tags can be highlighted
    activeSkills = skills;

    return jobs.filter((job) => {
        // Time
        if (cutoff && job.timestamp && job.timestamp < cutoff) return false;

        // Job type
        if (f.typeHourly || f.typeFixed) {
            const ok = (f.typeHourly && job.jobType === 'Hourly') ||
                (f.typeFixed && job.jobType === 'Fixed');
            if (!ok) return false;
        }

        // Skills (match against skill list OR title/description text)
        if (skills.length > 0) {
            const jobSkills = (job.skills || []).map((s) => s.toLowerCase());
            const text = `${job.title} ${job.description}`.toLowerCase();
            const matched = skills.some(
                (sk) => jobSkills.some((js) => js.includes(sk)) || text.includes(sk)
            );
            if (!matched) return false;
        }

        return true;
    });
}

// ── Rendering ─────────────────────────────────────────────────────────────────
function renderJobs() {
    const filtered = applyFilters(allJobs);

    if (filtered.length === 0) {
        elJobsList.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🔍</div>
        <div class="empty-text">No jobs match your filters.<br/>
          Try broader filters or wait for new jobs.</div>
      </div>`;
        return;
    }

    elJobsList.innerHTML = filtered.map(renderJobItem).join('');

    elJobsList.querySelectorAll('.job-item[data-url]').forEach((el) => {
        el.addEventListener('click', () => {
            if (el.dataset.url) chrome.tabs.create({url: el.dataset.url});
        });
    });
}

function renderJobItem(job) {
    const time = job.timestamp ? fmtAgo(job.timestamp) : '';

    const skillTags = (job.skills || []).map((s) => {
        const hi = activeSkills.some((f) => s.toLowerCase().includes(f));
        return `<span class="skill-tag${hi ? ' matched' : ''}">${esc(s)}</span>`;
    }).join('');

    return `<div class="job-item${job.isApplied ? ' applied' : ''}" data-url="${escAttr(job.url)}">
    <div class="job-title">${esc(job.title)}</div>
    <div class="job-meta">
      ${time ? `<span class="job-time">${time}</span>` : ''}
      ${job.budget ? `<span class="job-budget">${esc(job.budget)}</span>` : ''}
      ${job.jobType ? `<span class="job-badge">${esc(job.jobType)}</span>` : ''}
      ${job.tier ? `<span class="job-tier">${esc(job.tier)}</span>` : ''}
    </div>
    <div class="job-meta job-meta2">
      ${job.country ? `<span class="job-country">📍 ${esc(job.country)}</span>` : ''}
      ${job.proposals ? `<span class="job-proposals">📨 ${esc(job.proposals)}</span>` : ''}
      ${job.isApplied ? `<span class="job-applied">✓ Applied</span>` : ''}
    </div>
    ${skillTags ? `<div class="job-skills">${skillTags}</div>` : ''}
  </div>`;
}

// ── Event listeners ───────────────────────────────────────────────────────────

elBtnFilter.addEventListener('click', async () => {
    // Save current filter state to storage (background poll + jobs.html both read these)
    await chrome.storage.local.set({
        feedType: elFeedType.value,
        timeDays: elTimeFilter.value,
        skillsFilter: elSkillsInput.value,
        typeHourly: elTypeHourly.checked,
        typeFixed: elTypeFixed.checked,
    });
    renderJobs();
    // Refresh status count after filter change
    const visible = applyFilters(allJobs).length;
    const statusText = elStatusBar.querySelector('.text');
    if (statusText) statusText.textContent = `${visible} job${visible !== 1 ? 's' : ''} shown`;
});

elBtnViewAll.addEventListener('click', () => {
    chrome.tabs.create({url: chrome.runtime.getURL('jobs.html')});
});

elBtnRefresh.addEventListener('click', async () => {
    elBtnRefresh.disabled = true;
    elBtnRefresh.textContent = '…';
    try {
        await chrome.runtime.sendMessage({action: 'pollNow'});
        await loadAndRender();
    } finally {
        elBtnRefresh.disabled = false;
        elBtnRefresh.textContent = '⟳ Refresh';
    }
});

elEnableToggle.addEventListener('change', async () => {
    const val = elEnableToggle.checked;
    elToggleLabel.textContent = val ? 'ON' : 'OFF';
    elDisabledOverlay.classList.toggle('show', !val);
    await chrome.runtime.sendMessage({action: 'setEnabled', value: val});
});

elBtnClear.addEventListener('click', async () => {
    if (!confirm('Clear all stored jobs?')) return;
    await chrome.runtime.sendMessage({action: 'clearJobs'});
    allJobs = [];
    renderJobs();
    setStatus('success', 'All jobs cleared');
});

elAuthBtn.addEventListener('click', () => {
    chrome.tabs.create({url: 'https://www.upwork.com/ab/account-security/login'});
});

elFeedType.addEventListener('change', updateFeedHint);

// ── Helpers ───────────────────────────────────────────────────────────────────
function updateFeedHint() {
    elFeedHint.textContent = FEED_HINTS[elFeedType.value] || '';
}

function setStatus(type, text) {
    elStatusBar.className = `status-bar ${type}`;
    const spin = type === 'loading' ? '<div class="spinner"></div>' : '';
    elStatusBar.innerHTML = `${spin}<span class="text">${esc(text)}</span>`;
}

function showAuthBanner(variant) {
    elAuthBanner.className = `auth-banner show${variant === 'warn' ? ' warn' : ''}`;
    elAuthTitle.textContent = variant === 'warn'
        ? 'Session may be expiring'
        : 'Not logged in to Upwork';
    elAuthText.textContent = 'Log in to Upwork so the extension can fetch jobs on your behalf.';
}

function hideAuthBanner() {
    elAuthBanner.className = 'auth-banner';
}

function fmtAgo(ts) {
    const d = Date.now() - ts;
    const m = Math.floor(d / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
}

function esc(str) {
    return String(str || '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escAttr(str) {
    return esc(str).replace(/'/g, '&#39;');
}

// ── Start ─────────────────────────────────────────────────────────────────────
init();