// Job Hunt — panel UI. Runs in the LinkWatch window and reaches its backend only
// through ctx.invoke(...). Three tabs: Applications (what you've applied to),
// Resume (what the ranker scores against, editable), and Skill Gaps (what to add
// to your resume, mined from real postings). Registers via LW.registerPanel.
(function () {
  const STATUSES = [
    ['applied', 'Applied'], ['heard_back', 'Heard back'], ['interview', 'Interview'],
    ['offer', 'Offer'], ['rejected', 'Rejected'],
  ];
  const LABEL = Object.fromEntries(STATUSES);
  let activeTab = 'applications';
  let gapMode = 'window';   // 'window' = cumulative over recent scrapes, 'last' = most recent scrape

  async function render(root, ctx) {
    const esc = ctx.esc;
    root.innerHTML = `
      <div class="jh-tabs">
        <button class="jh-tab" data-tab="applications">Applications</button>
        <button class="jh-tab" data-tab="resume">Resume</button>
        <button class="jh-tab" data-tab="gaps">Skill Gaps</button>
      </div>
      <div class="jh-view" id="jhView"></div>`;
    root.querySelectorAll('.jh-tab').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === activeTab);
      b.onclick = () => { activeTab = b.dataset.tab; render(root, ctx); };
    });
    const view = root.querySelector('#jhView');
    if (activeTab === 'applications') await renderApps(view, ctx);
    else if (activeTab === 'resume') await renderResume(view, ctx);
    else await renderGaps(view, ctx);
  }

  // ── Applications ──────────────────────────────────────────────────────────
  async function renderApps(view, ctx) {
    const esc = ctx.esc;
    let apps = [];
    try { apps = await ctx.invoke('list'); } catch (_) { apps = []; }

    const head = `
      <div class="panel-head">
        <span class="panel-title">APPLICATIONS</span>
        <span class="panel-sub">${apps.length ? apps.length + ' tracked' : ''}</span>
        <div class="panel-head-right"><button class="btn" id="appsExport">Export CSV</button></div>
      </div>`;

    let body;
    if (!apps.length) {
      body = `<div class="jh-body"><div class="jh-empty">No applications tracked yet.<br>Open <b>Results</b> and click <b>+ Track</b> on a job to add it here — its link, company and title fill in automatically.</div></div>`;
    } else {
      const opts = sel => STATUSES.map(([v, l]) => `<option value="${v}"${v === sel ? ' selected' : ''}>${l}</option>`).join('');
      const rows = apps.map(a => {
        const u = encodeURIComponent(a.url);
        return `<tr data-id="${esc(a.id)}">
          <td><div class="apps-pos">${esc(a.title || 'Untitled')}</div></td>
          <td class="apps-company">${esc(a.company || '')}</td>
          <td><select class="apps-status status-${esc(a.status)}" data-k="status">${opts(a.status)}</select></td>
          <td><input type="date" class="apps-date" data-k="dateApplied" value="${esc(a.dateApplied || '')}"></td>
          <td><span class="apps-link" data-url="${u}" title="${esc(a.url)}">open ↗</span></td>
          <td><textarea class="apps-notes" rows="1" data-k="notes" placeholder="notes…">${esc(a.notes || '')}</textarea></td>
          <td><button class="apps-del" title="Remove">✕</button></td>
        </tr>`;
      }).join('');
      body = `<div class="jh-body"><table class="apps-table">
        <thead><tr><th>Position</th><th>Company</th><th>Status</th><th>Applied</th><th>Link</th><th>Notes</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table></div>`;
    }
    view.innerHTML = head + body;

    const exportBtn = view.querySelector('#appsExport');
    if (exportBtn) exportBtn.onclick = () => exportCsv(ctx);

    view.querySelectorAll('.apps-link').forEach(el => {
      el.onclick = () => ctx.openLink(decodeURIComponent(el.dataset.url));
    });

    view.querySelectorAll('tr[data-id]').forEach(tr => {
      const id = tr.dataset.id;
      const sel = tr.querySelector('.apps-status');
      if (sel) sel.onchange = async () => {
        sel.className = 'apps-status status-' + sel.value;
        await saveField(ctx, id, 'status', sel.value);
      };
      const date = tr.querySelector('.apps-date');
      if (date) date.onchange = () => saveField(ctx, id, 'dateApplied', date.value);
      const notes = tr.querySelector('.apps-notes');
      if (notes) notes.onblur = () => saveField(ctx, id, 'notes', notes.value);
      const del = tr.querySelector('.apps-del');
      if (del) del.onclick = async () => {
        const title = (tr.querySelector('.apps-pos') && tr.querySelector('.apps-pos').textContent) || 'this application';
        if (!(await ctx.confirm(`Remove "${title}" from your tracker?`, { title: 'Remove application', okText: 'Remove', danger: true }))) return;
        try { await ctx.invoke('remove', { id }); } catch (e) { ctx.alert('Could not remove: ' + e.message); return; }
        await ctx.refreshRows();   // revert that job's "+ Track" button in Results
        renderApps(view, ctx);
      };
    });
  }

  async function saveField(ctx, id, key, value) {
    try { await ctx.invoke('update', { id, patch: { [key]: value } }); }
    catch (e) { ctx.alert('Could not save: ' + e.message); }
  }

  function csvCell(s) { s = String(s == null ? '' : s); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  async function exportCsv(ctx) {
    let apps = [];
    try { apps = await ctx.invoke('list'); } catch (_) {}
    if (!apps.length) { ctx.alert('No applications to export yet.'); return; }
    const lines = [['Position', 'Company', 'Status', 'Applied', 'Link', 'Notes'].join(',')];
    for (const a of apps) lines.push([a.title, a.company, LABEL[a.status] || a.status, a.dateApplied, a.url, a.notes].map(csvCell).join(','));
    ctx.download('applications.csv', lines.join('\r\n'), 'text/csv');
  }

  // ── Resume ────────────────────────────────────────────────────────────────
  async function renderResume(view, ctx) {
    const esc = ctx.esc;
    let info = { hasResume: false, source: 'none', skillCount: 0, skills: [] };
    try { info = await ctx.invoke('resumeInfo'); } catch (_) {}

    const status = info.hasResume
      ? `Scoring against <b>${esc(info.file || 'resume.txt')}</b> — <b>${info.skillCount}</b> skill${info.skillCount === 1 ? '' : 's'} detected.`
      : `No resume file yet. Jobs are scored against the generic fallback weights. Paste your resume below to personalize ranking and skill gaps.`;

    const chips = info.skills.length
      ? `<div class="jh-chips">${info.skills.map(s => `<span class="jh-chip">${esc(s)}</span>`).join('')}</div>`
      : '';

    view.innerHTML = `
      <div class="panel-head">
        <span class="panel-title">RESUME</span>
        <span class="panel-sub">${info.hasResume ? 'personalized' : 'generic'}</span>
      </div>
      <div class="jh-body">
        <div class="jh-note">${status}</div>
        ${chips}
        <div class="jh-sub">Update resume</div>
        <div class="jh-hint">Paste your resume as plain text and save — it writes <code>resume.txt</code> and re-scores future scrapes. Stored only on this machine.</div>
        <textarea class="jh-resume-text" id="jhResumeText" placeholder="Paste your resume text here…"></textarea>
        <div class="jh-row">
          <button class="btn primary" id="jhResumeSave">Save resume</button>
          <span class="jh-saved" id="jhResumeSaved"></span>
        </div>
      </div>`;

    const btn = view.querySelector('#jhResumeSave');
    const ta = view.querySelector('#jhResumeText');
    const saved = view.querySelector('#jhResumeSaved');
    btn.onclick = async () => {
      const text = ta.value.trim();
      if (!text) { ctx.alert('Paste your resume text first.'); return; }
      btn.disabled = true; saved.textContent = 'Saving…';
      try {
        const r = await ctx.invoke('saveResume', { text });
        saved.textContent = `Saved — ${r.info.skillCount} skill${r.info.skillCount === 1 ? '' : 's'} detected.`;
        setTimeout(() => renderResume(view, ctx), 900);
      } catch (e) { saved.textContent = ''; ctx.alert('Could not save: ' + e.message); btn.disabled = false; }
    };
  }

  // ── Skill Gaps ────────────────────────────────────────────────────────────
  async function renderGaps(view, ctx) {
    const esc = ctx.esc;
    let rep = null;
    try { rep = await ctx.invoke('gapsReport'); } catch (_) {}
    // Fallback for an older backend that only has getGaps (last scrape).
    if (!rep) {
      try { const g = await ctx.invoke('getGaps'); rep = g ? { lastRun: g, window: null } : null; } catch (_) {}
    }

    const win  = rep && rep.window  && rep.window.missing  && rep.window.missing.length  ? rep.window  : null;
    const last = rep && rep.lastRun && rep.lastRun.missing && rep.lastRun.missing.length ? rep.lastRun : null;

    if (!win && !last) {
      view.innerHTML = `
        <div class="panel-head"><span class="panel-title">SKILL GAPS</span></div>
        <div class="jh-body"><div class="jh-empty">
          No gaps computed yet.<br>Run a scrape with <b>description fetching</b> on (it is by default), then come back — this tab shows which in-demand skills from the postings aren't on your resume yet.
        </div></div>`;
      return;
    }

    // Pick the view, falling back to whichever has data.
    let mode = gapMode;
    if (mode === 'window' && !win) mode = 'last';
    if (mode === 'last'   && !last) mode = 'window';
    const src  = mode === 'window' ? win : last;
    const days = win ? win.days : 30;

    const max = src.missing[0].count || 1;
    const when = last ? (() => { try { return new Date(last.computedAt).toLocaleString(); } catch { return ''; } })() : '';
    const bars = src.missing.map(g => {
      const pct = Math.max(6, Math.round((g.count / max) * 100));
      const sub = (mode === 'window' && g.runs) ? ` title="in ${g.runs} scrape${g.runs === 1 ? '' : 's'}"` : '';
      return `<div class="jh-gap"${sub}>
        <div class="jh-gap-name">${esc(g.skill)}</div>
        <div class="jh-gap-bar"><div class="jh-gap-fill" style="width:${pct}%"></div></div>
        <div class="jh-gap-count">${g.count}</div>
      </div>`;
    }).join('');

    const toggle = (win && last) ? `
      <div class="panel-head-right jh-gap-toggle">
        <button class="btn ${mode === 'window' ? 'primary' : ''}" data-m="window">Last ${days}d</button>
        <button class="btn ${mode === 'last' ? 'primary' : ''}" data-m="last">This scrape</button>
      </div>` : '';

    const note = mode === 'window'
      ? `In-demand skills that <b>aren't on your resume</b>, totaled across the last <b>${days} days</b> of scrapes. The number is how many postings asked for each — the ones that keep showing up are worth learning first.`
      : `In-demand skills from the <b>last scrape's</b> job descriptions that <b>aren't on your resume</b> yet. The number is how many postings asked for each.`;

    const foot = mode === 'window'
      ? `Across ${src.scrapes} scrape${src.scrapes === 1 ? '' : 's'} · ${src.jobsAnalyzed} description${src.jobsAnalyzed === 1 ? '' : 's'} · resume source: ${esc(src.resumeSource || 'none')}`
      : `Based on ${src.jobsAnalyzed} description${src.jobsAnalyzed === 1 ? '' : 's'} · resume source: ${esc(src.resumeSource || 'none')}${when ? ' · ' + esc(when) : ''}`;

    view.innerHTML = `
      <div class="panel-head">
        <span class="panel-title">SKILL GAPS</span>
        <span class="panel-sub">${src.jobsAnalyzed} posting${src.jobsAnalyzed === 1 ? '' : 's'}</span>
        ${toggle}
      </div>
      <div class="jh-body">
        <div class="jh-note">${note}</div>
        <div class="jh-gaps">${bars}</div>
        <div class="jh-foot">${foot}</div>
      </div>`;

    view.querySelectorAll('.jh-gap-toggle button').forEach(b => {
      b.onclick = () => { gapMode = b.dataset.m; renderGaps(view, ctx); };
    });
  }

  LW.registerPanel('job-hunt', { render });
})();
