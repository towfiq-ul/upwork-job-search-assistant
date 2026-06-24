'use strict';

/* ──────────────────────────────────────────────────────────────────────────
 * Upwork Job Search Assistant — jobs.html controller
 *
 * Reads jobs + filters from chrome.storage.local.
 * Splits jobs into "New Jobs" (ids in notificationJobIds) and
 * "Previously Seen". Applies the same filters saved by popup.js.
 * ────────────────────────────────────────────────────────────────────────*/

const elMain = document.getElementById('main-page');
const elLoading = document.getElementById('loading-state');
const elHcounts = document.getElementById('hcounts');
const elBackTop = document.getElementById('back-top');
const elFpFeed = document.getElementById('fp-feed');
const elFpTime = document.getElementById('fp-time');
const elFpType = document.getElementById('fp-type');
const elFpSkills = document.getElementById('fp-skills');

const FEED_LABELS = {
    mostRecent: 'Most Recent',
    bestMatches: 'Best Matches',
    myFeed: 'My Feed',
};

const TIME_LABELS = {
    '0.0417': 'Last 1 hr',
    '0.0833': 'Last 2 hrs',
    '0.125': 'Last 3 hrs',
    '0.25': 'Last 6 hrs',
    '0.5': 'Last 12 hrs',
    '1': 'Last 24 hrs',
    '3': 'Last 3 days',
    '7': 'Last 7 days',
    '14': 'Last 14 days',
    '30': 'Last 30 days',
    '9999': 'All time',
};

// ── Back-to-top button ────────────────────────────────────────────────────────
window.addEventListener('scroll', () => {
    elBackTop.classList.toggle('show', window.scrollY > 400);
}, {passive: true});

// When the user scrolls down 20px from the top, show the button
window.onscroll = function () {
    if (document.body.scrollTop > 20 || document.documentElement.scrollTop > 20) {
        elBackTop.style.display = "block";
    } else {
        elBackTop.style.display = "none";
    }
};

// When the user clicks on the button, scroll to the top
elBackTop.addEventListener("click", function () {
    window.scrollTo({
        top: 0,
        behavior: 'smooth'
    });
});

// ── Close button → just close this tab ───────────────────────────────────────
document.getElementById('btn-popup').addEventListener('click', (e) => {
    e.preventDefault();
    window.close();
});

// ── Main ──────────────────────────────────────────────────────────────────────
async function init() {
    const data = await chrome.storage.local.get([
        'jobs',
        'notificationJobIds',
        'feedType',
        'timeDays',
        'skillsFilter',
        'typeHourly',
        'typeFixed',
    ]);

    const allJobs = data.jobs || [];
    const notifIds = new Set(data.notificationJobIds || []);
    const feedType = data.feedType || 'mostRecent';
    const timeDays = parseFloat(data.timeDays || '7');
    const skillsFilter = data.skillsFilter || '';
    const typeHourly = !!data.typeHourly;
    const typeFixed = !!data.typeFixed;

    // ── Update filter bar pills ───────────────────────────────────────────────
    const feedLabel = FEED_LABELS[feedType] || feedType;
    const timeLabel = TIME_LABELS[String(data.timeDays)] || `${timeDays}d`;
    const typeLabel = typeHourly && typeFixed ? 'Hourly + Fixed'
        : typeHourly ? 'Hourly'
            : typeFixed ? 'Fixed'
                : 'Any type';
    const skillLabel = skillsFilter || 'Any skills';

    elFpFeed.textContent = feedLabel;
    elFpTime.textContent = timeLabel;
    elFpType.textContent = typeLabel;
    elFpSkills.textContent = skillLabel;

    elFpFeed.classList.toggle('active', true);
    elFpTime.classList.toggle('active', timeDays < 9999);
    elFpType.classList.toggle('active', typeHourly || typeFixed);
    elFpSkills.classList.toggle('active', !!skillsFilter);

    // ── Apply filters ─────────────────────────────────────────────────────────
    const skills = skillsFilter.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const cutoff = timeDays >= 9999 ? 0 : Date.now() - timeDays * 86400000;

    function matchesFilters(job) {
        if (cutoff && job.timestamp && job.timestamp < cutoff) return false;
        if (typeHourly || typeFixed) {
            const ok = (typeHourly && job.jobType === 'Hourly') ||
                (typeFixed && job.jobType === 'Fixed');
            if (!ok) return false;
        }
        if (skills.length > 0) {
            const jobSkills = (job.skills || []).map((s) => s.toLowerCase());
            const text = `${job.title} ${job.description}`.toLowerCase();
            const matched = skills.some(
                (sk) => jobSkills.some((js) => js.includes(sk)) || text.includes(sk)
            );
            if (!matched) return false;
        }
        return true;
    }

    const filtered = allJobs.filter(matchesFilters);

    // Split: new (from last notification) vs previously seen
    const newJobs = filtered.filter((j) => notifIds.size > 0 && notifIds.has(j.id));
    const seenJobs = filtered.filter((j) => !(notifIds.size > 0 && notifIds.has(j.id)));

    // ── Update header counts ──────────────────────────────────────────────────
    elHcounts.innerHTML = [
        newJobs.length > 0 ? `<span class="hcount new-count">🟢 ${newJobs.length} new</span>` : '',
        seenJobs.length > 0 ? `<span class="hcount">${seenJobs.length} previously seen</span>` : '',
        filtered.length === 0 ? `<span class="hcount">0 jobs match filters</span>` : '',
    ].join('');

    // ── Render ────────────────────────────────────────────────────────────────
    elLoading.remove();

    if (filtered.length === 0) {
        elMain.innerHTML = `<div class="empty">No jobs match your current filters.<br/>
      Adjust the filters in the popup and reopen this page.</div>`;
        return;
    }

    const sections = [];

    if (newJobs.length > 0) {
        sections.push(`
      <section class="section-new">
        <div class="section-header">
          <span class="section-title">🟢 New Jobs</span>
          <span class="section-badge badge-new">${newJobs.length}</span>
        </div>
        <div class="jobs-grid">${newJobs.map((j) => renderCard(j, skills, true)).join('')}</div>
      </section>`);
    }

    if (seenJobs.length > 0) {
        sections.push(`
      <section class="section-seen">
        <div class="section-header">
          <span class="section-title">Previously Seen</span>
          <span class="section-badge badge-seen">${seenJobs.length}</span>
        </div>
        <div class="jobs-grid">${seenJobs.map((j) => renderCard(j, skills, false)).join('')}</div>
      </section>`);
    }

    elMain.innerHTML = sections.join('');
}

// ── Card renderer ─────────────────────────────────────────────────────────────
function renderCard(job, activeSkills, isNew) {
    const time = job.timestamp ? fmtAgo(job.timestamp) : '';

    const skillTags = (job.skills || []).map((s) => {
        const hi = activeSkills.some((f) => s.toLowerCase().includes(f));
        return `<span class="skill-tag${hi ? ' matched' : ''}">${esc(s)}</span>`;
    }).join('');

    const metaParts = [
        job.budget ? `<span class="meta-budget">${esc(job.budget)}</span>` : '',
        job.jobType ? `<span class="meta-badge">${esc(job.jobType)}</span>` : '',
        job.tier ? `<span class="meta-tier">${esc(job.tier)}</span>` : '',
        job.isApplied ? `<span class="meta-applied">✓ Applied</span>` : '',
        time ? `<span class="meta-dot">·</span><span class="meta-time">${time}</span>` : '',
        job.country ? `<span class="meta-dot">·</span><span class="meta-country">📍 ${esc(job.country)}</span>` : '',
        job.proposals ? `<span class="meta-dot">·</span><span class="meta-proposals">📨 ${esc(job.proposals)}</span>` : '',
    ].filter(Boolean).join('');

    return `
    <div class="job-card${isNew ? ' is-new' : ''}${job.isApplied ? ' applied' : ''}">
      <a class="card-title" href="${escAttr(job.url)}" target="_blank" rel="noopener">${esc(job.title)}</a>
      <div class="card-meta">${metaParts}</div>
      ${skillTags ? `<div class="card-skills">${skillTags}</div>` : ''}
      ${job.description ? `<div class="card-desc">${esc(job.description)}</div>` : ''}
    </div>`;
}

// ── Utilities ─────────────────────────────────────────────────────────────────
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

init();