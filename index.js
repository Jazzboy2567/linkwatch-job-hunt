// Job Hunt — a LinkWatch extension that is BOTH a ranker and a panel.
//
// It does the whole job-hunt loop in one place:
//   • Ranker  — after every scrape it scores each job link against your resume
//               skills (fetching the real description when it can), sorts the best
//               matches to the top, tags each one entry-level / senior / clearance /
//               no-login, AND works out which in-demand skills the postings want that
//               your resume is missing — so you know what to learn next.
//   • Panel   — a "Job Hunt" sidebar tab with three views: Applications (track what
//               you've applied to), Resume (see/paste the resume it scores against),
//               and Skill Gaps (what to add to your resume, from real postings).
//   • Row action — a "+ Track" button on each result row.
//
// The ranker half is ported 1:1 from the old Resume Match extension (and the Python
// matcher it came from), so scoring is identical and fully explainable. The panel half
// folds in the old Applications tracker. Tune everything in config.json; drop a
// resume.txt in this folder (or paste one in the Resume tab) to personalize scoring.
//
// Nothing here is sent anywhere except the public job pages it fetches to read a
// description. Your resume and your application list never leave this machine.

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

let CFG = null;
let EXT_DIR = __dirname;
let logFn = () => {};
let store = null;
let helpers = {};
let emitFn = () => {};

// The skills the ranker scores against — read from your resume at init() if one is
// present, otherwise the config.json skillWeights fallback.
let WEIGHTS = {};
let WEIGHTS_SOURCE = 'none';
let RESUME_PATH = null;

const DEFAULTS = {
  fetchDescriptions: true, maxFetch: 25, concurrency: 4, fetchTimeoutMs: 9000,
  sortBy: 'score', hideBelow: null, dedupe: true, experienceFirst: true,
  resumeFile: 'resume.txt', resumePath: null,
  skillVocabulary: [], skillWeights: {}, softwareIndicators: [],
  titleGood: [], titleBad: [], entrySignals: [], seniorSignals: [], clearanceSignals: [],
  gapTopN: 20, gapMinLen: 3,
};

// Fallback vocabulary used to read skills out of a resume (and to spot in-demand
// skills in job descriptions for the gap analysis) when config.json doesn't supply
// its own skillVocabulary. Broad on purpose so the extension isn't tied to one field.
const BUILTIN_VOCAB = [
  'python','java','c++','c#','javascript','typescript','sql','html','css','golang',
  'rust','kotlin','swift','php','ruby','scala','matlab','bash','powershell',
  'react','angular','vue','node','django','flask','spring','.net','express',
  'pandas','numpy','pytorch','tensorflow','scikit-learn','streamlit',
  'rest','graphql','api','microservices','docker','kubernetes','terraform',
  'aws','azure','gcp','linux','git','github','gitlab','ci/cd','jenkins',
  'postgres','mysql','mongodb','redis','database','etl','spark','hadoop','kafka',
  'machine learning','deep learning','data structures','algorithms','data analysis',
  'tableau','power bi','excel','r programming','sas','spss',
  'testing','test automation','selenium','cypress','qa','quality assurance','jira',
  'agile','scrum','arcgis','gis','autocad','solidworks','figma','photoshop',
  'project management','salesforce','accounting','marketing','seo','copywriting',
];

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'config.json'), 'utf8'));
    return { ...DEFAULTS, ...raw };
  } catch (e) {
    logFn('warn', `couldn't read config.json (${e.message}); using defaults`);
    return { ...DEFAULTS };
  }
}

function vocab() {
  return (CFG.skillVocabulary && CFG.skillVocabulary.length) ? CFG.skillVocabulary : BUILTIN_VOCAB;
}

// ── Resume-driven skills (makes this general, not tied to one resume) ────────
// Count whole-word hits so "java" doesn't match inside "javascript". Terms with
// symbols (c++, ci/cd, .net) can't use \b cleanly, so fall back to substring.
function countMatches(hay, term) {
  if (/[^a-z0-9 ]/.test(term)) {
    let c = 0, i = hay.indexOf(term);
    while (i !== -1) { c++; i = hay.indexOf(term, i + term.length); }
    return c;
  }
  const re = new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'g');
  let c = 0;
  while (re.exec(hay) !== null) c++;
  return c;
}

// Does a term appear in a blob at all (same word-boundary rule as countMatches)?
function hasTerm(hay, term) {
  if (/[^a-z0-9 ]/.test(term)) return hay.indexOf(term) !== -1;
  const re = new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`);
  return re.test(hay);
}

function readResume() {
  const tries = [];
  if (CFG.resumePath) tries.push(CFG.resumePath);
  if (CFG.resumeFile) tries.push(path.join(EXT_DIR, CFG.resumeFile));
  tries.push(path.join(EXT_DIR, 'resume.txt'), path.join(EXT_DIR, 'resume.md'));
  for (const p of tries) {
    try { const t = fs.readFileSync(p, 'utf8'); if (t && t.trim()) return { text: t, path: p }; }
    catch (_) {}
  }
  return null;
}

function applyResume() {
  const v = vocab();
  const r = readResume();
  RESUME_PATH = r ? r.path : null;
  if (!r) {
    WEIGHTS = CFG.skillWeights || {};
    WEIGHTS_SOURCE = Object.keys(WEIGHTS).length ? 'config.json skillWeights' : 'none';
    logFn('info', `no resume file found; scoring against config skillWeights (drop a resume.txt in ${EXT_DIR} or paste one in the Resume tab to personalize)`);
    return;
  }
  const hay = ` ${r.text.toLowerCase().replace(/\s+/g, ' ')} `;
  const w = {};
  for (const termRaw of v) {
    const term = String(termRaw).toLowerCase().trim();
    if (term.length < 3 && !/[^a-z]/.test(term)) continue;   // skip ambiguous 1–2 letter tokens
    const c = countMatches(hay, term);
    if (c > 0) w[term] = Math.max(1, Math.min(3, c));
  }
  if (Object.keys(w).length) {
    WEIGHTS = w;
    WEIGHTS_SOURCE = `resume (${path.basename(r.path)})`;
    const names = Object.keys(w).sort((a, b) => w[b] - w[a]);
    logFn('info', `resume skills (${names.length}): ${names.slice(0, 12).join(', ')}${names.length > 12 ? '…' : ''}`);
  } else {
    WEIGHTS = CFG.skillWeights || {};
    WEIGHTS_SOURCE = 'config.json skillWeights (no known skills found in resume)';
    logFn('warn', `found ${path.basename(r.path)} but matched no vocabulary skills; using config skillWeights`);
  }
}

// The resume's own skill set (lowercased vocabulary terms present in the resume),
// used both for scoring weights and to decide which demanded skills are "missing".
function resumeSkillSet() {
  return new Set(Object.keys(WEIGHTS).map(s => s.trim()));
}

// ── HTTP (follows a few redirects, hard timeout) ────────────────────────────
function httpGet(url, timeoutMs, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    let mod;
    try { mod = new URL(url).protocol === 'http:' ? http : https; }
    catch (e) { return reject(e); }
    const req = mod.get(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' } }, res => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        const next = new URL(res.headers.location, url).href;
        return resolve(httpGet(next, timeoutMs, redirectsLeft - 1));
      }
      if (code >= 400) { res.resume(); return reject(new Error(`HTTP ${code}`)); }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', d => { data += d; if (data.length > 2_000_000) req.destroy(); });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
  });
}

// ── Description fetching ────────────────────────────────────────────────────
function linkedinJobId(url) {
  const m = url.match(/\/jobs\/view\/(?:[^/?]*-)?(\d{6,})/) || url.match(/currentJobId=(\d{6,})/);
  return m ? m[1] : null;
}

function stripHtml(s) {
  return (s || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractLinkedinDesc(htmlText) {
  const m = htmlText.match(/<div[^>]*class="[^"]*show-more-less-html__markup[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
         || htmlText.match(/<section[^>]*class="[^"]*description[^"]*"[^>]*>([\s\S]*?)<\/section>/i);
  return stripHtml(m ? m[1] : htmlText);
}

async function fetchDescription(url, timeoutMs) {
  const jid = url.includes('linkedin.com') ? linkedinJobId(url) : null;
  if (jid) {
    const guest = `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${jid}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const desc = extractLinkedinDesc(await httpGet(guest, timeoutMs));
        if (desc && desc.length > 200) return desc;
      } catch (_) {}
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
    }
    return '';   // don't fall back to the login-wall page
  }
  try { return stripHtml(await httpGet(url, timeoutMs)); }
  catch (_) { return ''; }
}

// ── Disk cache for descriptions (keyed by url) ──────────────────────────────
function cacheDir(ctx) {
  return (ctx && ctx.cacheDir) || path.join(EXT_DIR, '.cache');
}
function cachePath(ctx, url) {
  const key = url.replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 120);
  return path.join(cacheDir(ctx), key + '.txt');
}
function readCache(ctx, url) {
  try { return fs.readFileSync(cachePath(ctx, url), 'utf8'); } catch (_) { return null; }
}
function writeCache(ctx, url, desc) {
  try {
    fs.mkdirSync(cacheDir(ctx), { recursive: true });
    fs.writeFileSync(cachePath(ctx, url), desc || '');
  } catch (_) {}
}

// ── Scoring (ported 1:1 from the matcher) ───────────────────────────────────
function atsOf(u) {
  const h = (u || '').toLowerCase();
  if (h.includes('greenhouse.io')) return 'greenhouse';
  if (h.includes('lever.co')) return 'lever';
  if (h.includes('ashbyhq.com')) return 'ashby';
  if (h.includes('myworkdayjobs.com')) return 'workday';
  if (h.includes('linkedin.com')) return 'linkedin';
  return 'other';
}

function isJobish(title, url) {
  const t = ` ${(title || '').toLowerCase()} `;
  if (CFG.titleBad.some(b => t.includes(b))) return false;
  if (CFG.softwareIndicators.some(ind => t.includes(ind.trim()))) return true;
  return atsOf(url) !== 'other';
}

function scoreJob(title, desc, url) {
  const t = (title || '').toLowerCase();
  const d = (desc || '').toLowerCase();
  const text = t + ' \n ' + d;

  const matched = [];
  let skill = 0;
  for (const [s, w] of Object.entries(WEIGHTS)) {
    if (text.includes(s)) { skill += w; matched.push(s.trim()); }
  }
  const titleBonus   = CFG.titleGood.filter(g => t.includes(g)).length * 3;
  const titlePenalty = CFG.titleBad.filter(b => t.includes(b)).length * 6;

  const entryTitle  = CFG.entrySignals.some(s => t.includes(s));
  const leadTitle   = /\blead\b/.test(t) && !/\blead generation\b/.test(t);
  const seniorTitle = leadTitle || CFG.seniorSignals.some(s => t.includes(s));
  const strongSeniorDesc = /\b(?:[5-9]|1\d)\+?\s*years?\b/.test(d);
  const senior = !entryTitle && (seniorTitle || strongSeniorDesc);
  const entry  = entryTitle || (!senior && CFG.entrySignals.some(s => d.includes(s)));
  const clearance = CFG.clearanceSignals.some(s => text.includes(s));

  const score = skill + titleBonus + (entry ? 8 : 0)
              - titlePenalty - (senior ? 12 : 0) - (clearance ? 20 : 0);

  const ats = atsOf(url);
  return {
    score,
    matchedSkills: [...new Set(matched)].sort(),
    ats,
    noLogin: ats === 'greenhouse' || ats === 'lever' || ats === 'ashby',
    entry,
    senior, clearance,
    hasDesc: !!desc,
  };
}

// Skills a posting demands that your resume doesn't have. Scans the full vocabulary
// against the posting text and subtracts the skills already on your resume.
function missingSkillsFor(title, desc) {
  const have = resumeSkillSet();
  const hay = ` ${(String(title || '') + ' \n ' + String(desc || '')).toLowerCase().replace(/\s+/g, ' ')} `;
  const minLen = CFG.gapMinLen || 3;
  const out = [];
  for (const termRaw of vocab()) {
    const term = String(termRaw).toLowerCase().trim();
    if (term.length < minLen && !/[^a-z]/.test(term)) continue;
    if (have.has(term)) continue;
    if (hasTerm(hay, term)) out.push(term);
  }
  return out;
}

function badgesFor(r) {
  const b = [];
  if (r.noLogin)    b.push('no-login');
  if (r.entry)      b.push('entry-level');
  if (r.senior)     b.push('senior');
  if (r.clearance)  b.push('clearance');
  if (!r.hasDesc)   b.push('title-only');
  return b;
}

// ── Simple concurrency pool ─────────────────────────────────────────────────
async function mapPool(items, limit, worker) {
  const out = new Array(items.length);
  let i = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return out;
}

// ── Near-duplicate collapsing ───────────────────────────────────────────────
function dupeKey(link) {
  const title = (link.title || link.text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  let company = '';
  const m = (link.url || '').match(/-at-([a-z0-9][a-z0-9-]*?)-\d{6,}/i);
  if (m) company = m[1].toLowerCase();
  else { try { company = new URL(link.url).host.replace(/^www\./, ''); } catch (_) {} }
  return title + '::' + company;
}

// ── The ranker entry point ──────────────────────────────────────────────────
async function rank(links, ctx) {
  if (!CFG) CFG = loadConfig();
  if (!Array.isArray(links) || links.length === 0) return links;

  const items = links.map(l => ({ link: l, title: l.title || l.text || '', url: l.url || '' }));

  const quick = items.map((it, idx) => ({ idx, q: scoreJob(it.title, '', it.url).score,
                                          jobish: isJobish(it.title, it.url) }));
  const toFetch = new Set();
  if (CFG.fetchDescriptions) {
    quick.filter(x => x.jobish).sort((a, b) => b.q - a.q)
         .slice(0, CFG.maxFetch).forEach(x => toFetch.add(x.idx));
  }

  const idxList = [...toFetch];
  const descByIdx = {};
  if (idxList.length) {
    logFn('info', `fetching ${idxList.length} job description(s)…`);
    await mapPool(idxList, CFG.concurrency, async (idx) => {
      const url = items[idx].url;
      let desc = readCache(ctx, url);
      if (desc === null) {
        desc = await fetchDescription(url, CFG.fetchTimeoutMs);
        writeCache(ctx, url, desc);
      }
      descByIdx[idx] = desc;
    });
  }

  // Score + annotate, and collect the skill-gap demand from every posting that
  // carried a real description (title-only rows are too thin to judge a gap on).
  const gapCount = {};          // missing skill -> how many postings wanted it
  let gapJobs = 0;
  let scored = items.map((it, idx) => {
    const desc = descByIdx[idx] || '';
    const r = scoreJob(it.title, desc, it.url);
    it.link.score = r.score;
    it.link.matchedSkills = r.matchedSkills;
    it.link.ats = r.ats;
    it.link.noLogin = r.noLogin;
    it.link.badges = badgesFor(r);
    if (desc) {
      const miss = missingSkillsFor(it.title, desc);
      it.link.missingSkills = miss;
      gapJobs++;
      for (const s of miss) gapCount[s] = (gapCount[s] || 0) + 1;
    } else {
      it.link.missingSkills = [];
    }
    return { link: it.link, r };
  });

  if (CFG.dedupe !== false) {
    const best = new Map();
    for (const s of scored) {
      const k = dupeKey(s.link);
      const cur = best.get(k);
      if (!cur || s.r.score > cur.r.score) best.set(k, s);
    }
    if (best.size && best.size < scored.length) {
      logFn('info', `collapsed ${scored.length - best.size} repeat posting(s)`);
      scored = [...best.values()];
    }
  }

  let kept = scored;
  if (typeof CFG.hideBelow === 'number') kept = kept.filter(s => s.r.score >= CFG.hideBelow);

  const expRank = s => (s.r.entry ? 0 : (s.r.senior ? 2 : 1));
  kept.sort((a, b) => {
    if (CFG.experienceFirst !== false) {
      const e = expRank(a) - expRank(b);
      if (e) return e;
    }
    if (CFG.sortBy === 'ats') {
      const rank = { greenhouse: 0, lever: 0, ashby: 0, other: 1, workday: 1, linkedin: 2 };
      const d = (rank[a.r.ats] ?? 1) - (rank[b.r.ats] ?? 1);
      if (d) return d;
    }
    return b.r.score - a.r.score;
  });

  // Persist the skill-gap snapshot so the panel's "Skill Gaps" tab can show what to
  // work on next, even after the window reloads.
  if (gapJobs > 0 && store) {
    const top = Object.entries(gapCount)
      .map(([skill, count]) => ({ skill, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, CFG.gapTopN || 20);
    const snap = {
      computedAt: new Date().toISOString(),
      jobsAnalyzed: gapJobs,
      resumeSource: WEIGHTS_SOURCE,
      resumeSkillCount: resumeSkillSet().size,
      missing: top,
    };
    try { store.set('gaps', snap); } catch (_) {}
    try { emitFn('gaps-updated', snap); } catch (_) {}
  }

  logFn('info', `scored ${scored.length} link(s); top score ${kept[0]?.r.score ?? 0}` +
                (gapJobs ? `; found ${Object.keys(gapCount).length} skill(s) your resume is missing across ${gapJobs} description(s)` : ''));
  return kept.map(s => s.link);
}

// ── Applications tracker (panel + row action backend) ───────────────────────
function allApps() {
  const d = store.all();
  return Array.isArray(d.apps) ? d.apps : [];
}
function saveApps(apps) {
  const d = store.all();
  d.apps = apps;
  store.replace(d);   // keep other keys (e.g. gaps) intact
}

// Today's date as yyyy-mm-dd in LOCAL time (toISOString is UTC, a day ahead at night).
function todayLocal() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function addApp(data) {
  const url = ((data && data.url) || '').trim();
  if (!url) return { ok: false, message: 'No URL.' };
  const apps = allApps();
  const existing = apps.find(a => a.url === url);
  if (existing) return { ok: true, duplicate: true, entry: existing };
  const entry = {
    id: 'app_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    url,
    title: ((data.title && data.title.trim()) ||
            (helpers.deriveTitleFromUrl && helpers.deriveTitleFromUrl(url)) || 'Untitled'),
    company: ((data.company && data.company.trim()) ||
              (helpers.deriveCompanyFromUrl && helpers.deriveCompanyFromUrl(url)) || ''),
    status: data.status || 'applied',
    dateApplied: data.dateApplied || todayLocal(),
    notes: data.notes || '',
    createdAt: new Date().toISOString(),
  };
  apps.unshift(entry);
  saveApps(apps);
  return { ok: true, entry };
}

// One-time import from the extensions this one replaces (old standalone "applications"
// store, and the even older built-in tracker), so nothing is lost in the merge.
function migrateApps(host) {
  if (allApps().length) return;
  const sources = [
    path.join(host.paths.userData, 'ext-data', 'applications.json'),  // old applications ext store
    path.join(host.paths.userData, 'applications.json'),             // original built-in tracker
  ];
  for (const p of sources) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      const items = Array.isArray(raw) ? raw : (Array.isArray(raw.items) ? raw.items : null);
      if (items && items.length) {
        saveApps(items);
        logFn('info', `imported ${items.length} application(s) from ${path.basename(path.dirname(p))}/${path.basename(p)}`);
        return;
      }
    } catch (e) { logFn('warn', `applications migration from ${p} skipped: ${e.message}`); }
  }
}

// ── Resume view / update (panel) ────────────────────────────────────────────
function resumeInfo() {
  const names = Object.keys(WEIGHTS).sort((a, b) => (WEIGHTS[b] - WEIGHTS[a]) || a.localeCompare(b));
  return {
    hasResume: !!RESUME_PATH,
    source: WEIGHTS_SOURCE,
    file: RESUME_PATH ? path.basename(RESUME_PATH) : null,
    skillCount: names.length,
    skills: names,
  };
}

function saveResume(text) {
  const body = String((text && text.text != null ? text.text : text) || '');
  if (!body.trim()) return { ok: false, message: 'Resume text is empty.' };
  const dest = path.join(EXT_DIR, 'resume.txt');
  try { fs.writeFileSync(dest, body, 'utf8'); }
  catch (e) { return { ok: false, message: 'Could not save resume.txt: ' + e.message }; }
  CFG = loadConfig();
  applyResume();
  logFn('info', `resume updated (${resumeSkillSet().size} skill(s) detected)`);
  return { ok: true, info: resumeInfo() };
}

// ── Extension lifecycle ─────────────────────────────────────────────────────
function init(host) {
  // Rankers and panels both receive the full host object here.
  if (host && host.dir) EXT_DIR = host.dir;
  if (host && host.log) logFn = host.log;
  if (host && host.store) store = host.store;
  if (host && host.helpers) helpers = host.helpers;
  if (host && host.emit) emitFn = host.emit;
  CFG = loadConfig();
  applyResume();

  // Panel/row-action backend methods are only wired when we were given the host IPC
  // (i.e. loaded as a UI extension). Rankers get the same init() but no ipc bridge.
  if (host && host.ipc && typeof host.ipc.handle === 'function') {
    if (store) migrateApps(host);

    // Applications tracker
    host.ipc.handle('list', () => allApps());
    host.ipc.handle('track', (p) => addApp(p));
    host.ipc.handle('add', (p) => addApp(p));
    host.ipc.handle('trackedUrls', () => allApps().map(a => a.url));
    host.ipc.handle('update', (p) => {
      const apps = allApps();
      const a = apps.find(x => x.id === (p && p.id));
      if (!a) return { ok: false, message: 'Not found.' };
      for (const k of ['title', 'company', 'status', 'dateApplied', 'notes']) {
        if (p.patch && k in p.patch) a[k] = p.patch[k];
      }
      saveApps(apps);
      return { ok: true, entry: a };
    });
    host.ipc.handle('remove', (p) => {
      saveApps(allApps().filter(x => x.id !== (p && p.id)));
      return { ok: true };
    });

    // Resume view / update
    host.ipc.handle('resumeInfo', () => resumeInfo());
    host.ipc.handle('saveResume', (p) => saveResume(p));

    // Skill gaps
    host.ipc.handle('getGaps', () => (store.get('gaps') || null));
  }
}

module.exports = { init, rank };
