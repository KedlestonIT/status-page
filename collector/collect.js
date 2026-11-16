// Collects live status from vendor status pages and normalises it.
// No dependencies: uses Node's global fetch and regex parsing.

const SECURLY_PAGE_ID = '5721276eb12b2e5843002acb';
const SECURLY_API = `https://api.status.io/1.0/status/${SECURLY_PAGE_ID}`;
const SECURLY_PAGE = 'https://status.securly.com';
const ARBOR_PAGE = 'https://status.arbor-education.com';
const M365_FEED = 'https://status.cloud.microsoft/api/feed/mac';
const M365_PAGE = 'https://status.cloud.microsoft';

// Normalised levels, ordered by severity.
const LEVEL = { operational: 0, maintenance: 1, degraded: 2, partial: 3, outage: 4 };
const LABEL = {
  operational: 'Operational',
  maintenance: 'Maintenance',
  degraded: 'Degraded performance',
  partial: 'Partial outage',
  outage: 'Major outage',
  unknown: 'Status unavailable',
};

const worst = (statuses) =>
  statuses.filter((s) => s in LEVEL).reduce((a, b) => (LEVEL[b] > LEVEL[a] ? b : a), 'operational');

async function get(url, type = 'text') {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'status-page-collector/1.0' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
  return type === 'json' ? res.json() : res.text();
}

const decode = (s = '') =>
  s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

// ---------- Securly (Status.io) ----------
// Status.io codes: 100 operational, 200 planned maintenance, 300 degraded,
// 400 partial disruption, 500 disruption, 600 security event.
function securlyLevel(code) {
  if (code <= 100) return 'operational';
  if (code === 200) return 'maintenance';
  if (code === 300) return 'degraded';
  if (code === 400) return 'partial';
  return 'outage';
}

// Which Securly component (and optionally region container) each card tracks.
const SECURLY_PRODUCTS = [
  { id: 'securly-filter', name: 'Securly Filter', component: 'Filter', container: 'UK' },
  { id: 'securly-classroom', name: 'Securly Classroom', component: 'Classroom' },
  { id: 'securly-aware', name: 'Securly Aware', component: 'Aware' },
];

async function securly() {
  const { result } = await get(SECURLY_API, 'json');
  const incidents = (result.incidents || []).filter((i) => i.current_active !== false);
  const maint = [...(result.maintenance?.active || [])];
  const upcoming = [...(result.maintenance?.upcoming || [])];

  return SECURLY_PRODUCTS.map((p) => {
    const comp = result.status.find((c) => c.name === p.component);
    if (!comp) return unavailable(p.id, p.name, 'Securly', SECURLY_PAGE, `Component "${p.component}" not found`);

    // Prefer the UK region where the vendor reports one.
    const region = p.container && comp.containers.find((c) => c.name === p.container);
    const primary = region || comp;
    const components = comp.containers.map((c) => ({
      name: c.name,
      status: securlyLevel(c.status_code),
      statusText: c.status,
    }));

    const affects = (i) => (i.components_affected || []).some((c) => c._id === comp.id);
    const toIncident = (i, kind) => {
      const last = (i.messages || []).at(-1) || {};
      return {
        kind,
        title: i.name,
        status: kind === 'maintenance' ? 'maintenance' : securlyLevel(last.state ?? 300),
        started: i.datetime_open || i.datetime_planned_start,
        ends: i.datetime_planned_end,
        updated: last.datetime || i.datetime_open,
        message: decode(last.details || ''),
        url: SECURLY_PAGE,
      };
    };

    const active = [
      ...incidents.filter(affects).map((i) => toIncident(i, 'incident')),
      ...maint.filter(affects).map((i) => toIncident(i, 'maintenance')),
    ];
    const planned = upcoming.filter(affects).map((i) => toIncident(i, 'maintenance'));

    // Status.io leaves component codes at 100 for "informational" incidents,
    // so an active incident lifts the card to at least "degraded".
    let status = securlyLevel(primary.status_code);
    if (active.some((a) => a.kind === 'incident')) status = worst([status, 'degraded']);

    return {
      id: p.id,
      name: p.name,
      vendor: 'Securly',
      status,
      statusText: status === securlyLevel(primary.status_code) ? primary.status : LABEL[status],
      scope: region ? `${p.container} region` : null,
      components,
      incidents: active,
      upcoming: planned,
      url: SECURLY_PAGE,
      updated: primary.updated || result.status_overall?.updated,
    };
  });
}

// ---------- Arbor (Statuspal HTML) ----------
function arborLevel(type) {
  switch (type) {
    case 'none': return 'operational';
    case 'scheduled': return 'maintenance';
    case 'minor': return 'degraded';
    case 'major': return 'outage';
    default: return 'unknown';
  }
}

async function arbor() {
  const html = await get(ARBOR_PAGE);

  const components = [];
  const re = /<div id="service-\d+" class="service-status status-type-([a-z]+)[^"]*">\s*<div class="service-status--info">[\s\S]*?<span class="service-status--name">([^<]+)<\/span>\s*<span class="service-status--status">([^<]+)<\/span>/g;
  for (const m of html.matchAll(re)) {
    components.push({ name: decode(m[2]), status: arborLevel(m[1]), statusText: decode(m[3]) });
  }
  if (!components.length) throw new Error('Could not read services from Arbor status page (layout may have changed)');

  // Incident cards between the "Current incidents" and "Past incidents" markers.
  const section = (start, end) => {
    const a = html.indexOf(start);
    const b = html.indexOf(end, a + 1);
    return a === -1 ? '' : html.slice(a, b === -1 ? undefined : b);
  };
  const cards = (chunk, kind) =>
    [...chunk.matchAll(/<a class="card incident status-type-([a-z]+)[^"]*" href="([^"]+)">([\s\S]*?)<\/a>/g)].map((m) => {
      const body = m[3];
      const title = decode((body.match(/<div class="incident--title">([\s\S]*?)<\/div>/) || [])[1])
        .replace(/^(Information|Minor|Major|Scheduled maintenance|Maintenance)\s+/i, '');
      return {
        kind,
        title,
        status: kind === 'maintenance' ? 'maintenance' : arborLevel(m[1]),
        message: decode((body.match(/<div class="incident--current-status markdown">([\s\S]*?)<\/div>/) || [])[1]),
        updated: (body.match(/data-js-date="([^"]+)"/) || [])[1],
        services: [...body.matchAll(/<span class="incident--service">([^<]+)<\/span>/g)].map((s) => decode(s[1])),
        url: m[2],
      };
    });

  const active = cards(section('<!-- Current incidents -->', '<!-- Future maintenances -->'), 'incident');
  const upcoming = cards(section('<!-- Future maintenances -->', '<!-- Past incidents -->'), 'maintenance');

  // The headline card reflects the MIS itself; other Arbor services are listed underneath.
  const mis = components.filter((c) => /MIS/i.test(c.name));
  const status = worst((mis.length ? mis : components).map((c) => c.status));

  return [{
    id: 'arbor-mis',
    name: 'Arbor MIS',
    vendor: 'Arbor Education',
    status,
    statusText: LABEL[status],
    scope: null,
    components,
    incidents: active,
    upcoming,
    url: ARBOR_PAGE,
    updated: null,
  }];
}

// ---------- Microsoft 365 (public status feed) ----------
function m365Level(text = '') {
  const t = text.toLowerCase();
  if (!t || t === 'available' || t.includes('restored') || t.includes('resolved')) return 'operational';
  if (t.includes('interruption') || t.includes('outage')) return 'outage';
  if (t.includes('maintenance')) return 'maintenance';
  return 'degraded'; // degradation, investigating, extended recovery, etc.
}

async function m365() {
  const xml = await get(M365_FEED);
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => {
    const tag = (n) => decode((m[1].match(new RegExp(`<${n}[^>]*>([\\s\\S]*?)</${n}>`)) || [])[1] || '');
    const statusText = tag('status');
    return {
      kind: 'incident',
      title: tag('title'),
      statusText,
      status: m365Level(statusText),
      message: decode(tag('description')),
      updated: tag('pubDate') ? new Date(tag('pubDate')).toISOString() : null,
      url: M365_PAGE,
    };
  });

  const active = items.filter((i) => i.status !== 'operational');
  const status = worst(active.map((i) => i.status));
  return [{
    id: 'm365',
    name: 'Microsoft 365',
    vendor: 'Microsoft',
    status,
    statusText: active.length ? LABEL[status] : 'Operational',
    scope: 'Widespread incidents only',
    components: [],
    incidents: active,
    upcoming: [],
    url: M365_PAGE,
    updated: items[0]?.updated || null,
  }];
}

// ---------- Trelson (Atlassian Statuspage) ----------
const TRELSON_PAGE = 'https://trelson.statuspage.io';

function statuspageLevel(s) {
  switch (s) {
    case 'operational': return 'operational';
    case 'under_maintenance': return 'maintenance';
    case 'degraded_performance': return 'degraded';
    case 'partial_outage': return 'partial';
    case 'major_outage': return 'outage';
    default: return 'unknown';
  }
}
const impactLevel = (i) => ({ none: 'degraded', minor: 'degraded', major: 'partial', critical: 'outage' }[i] || 'degraded');

async function trelson() {
  const data = await get(`${TRELSON_PAGE}/api/v2/summary.json`, 'json');
  const components = data.components
    .filter((c) => !c.group)
    .map((c) => ({ id: c.id, name: c.name, status: statuspageLevel(c.status), statusText: LABEL[statuspageLevel(c.status)] }));

  const toIncident = (i, kind) => {
    const last = (i.incident_updates || [])[0] || {};
    return {
      kind,
      title: i.name,
      status: kind === 'maintenance' ? 'maintenance' : impactLevel(i.impact),
      started: i.started_at || i.scheduled_for || i.created_at,
      ends: i.scheduled_until,
      updated: last.updated_at || i.updated_at,
      message: decode(last.body || ''),
      url: i.shortlink || TRELSON_PAGE,
    };
  };
  const maint = data.scheduled_maintenances || [];
  const active = [
    ...(data.incidents || []).map((i) => toIncident(i, 'incident')),
    ...maint.filter((m) => m.status === 'in_progress' || m.status === 'verifying').map((m) => toIncident(m, 'maintenance')),
  ];
  const upcoming = maint.filter((m) => m.status === 'scheduled').map((m) => toIncident(m, 'maintenance'));

  // Headline follows the exam tool (Assessment); Class Manager is listed underneath.
  const exams = components.find((c) => /assessment/i.test(c.name));
  let status = exams ? exams.status : worst(components.map((c) => c.status));
  if (data.incidents?.length) status = worst([status, 'degraded']);

  return [{
    id: 'trelson',
    name: 'Trelson Exams',
    vendor: 'Trelson',
    status,
    statusText: LABEL[status],
    scope: null,
    components: components.map(({ id, ...c }) => c),
    incidents: active,
    upcoming,
    url: TRELSON_PAGE,
    updated: data.page?.updated_at || null,
  }];
}

function unavailable(id, name, vendor, url, error) {
  return {
    id, name, vendor, url,
    status: 'unknown',
    statusText: LABEL.unknown,
    scope: null, components: [], incidents: [], upcoming: [],
    error, updated: null,
  };
}

// Order the cards appear on the page.
const SOURCES = [
  { fn: m365, fallback: [['m365', 'Microsoft 365', 'Microsoft', M365_PAGE]] },
  { fn: securly, fallback: SECURLY_PRODUCTS.map((p) => [p.id, p.name, 'Securly', SECURLY_PAGE]) },
  { fn: arbor, fallback: [['arbor-mis', 'Arbor MIS', 'Arbor Education', ARBOR_PAGE]] },
  { fn: trelson, fallback: [['trelson', 'Trelson Exams', 'Trelson', TRELSON_PAGE]] },
];

async function collect() {
  const results = await Promise.all(
    SOURCES.map(async ({ fn, fallback }) => {
      try {
        return await fn();
      } catch (err) {
        return fallback.map(([id, name, vendor, url]) => unavailable(id, name, vendor, url, err.message));
      }
    })
  );
  const services = results.flat();
  return {
    generatedAt: new Date().toISOString(),
    overall: worst(services.map((s) => s.status)),
    services,
  };
}

module.exports = { collect, LABEL };

// `node collector/collect.js` prints the current snapshot.
// `node collector/collect.js site/status.json` writes it to a file (used by the GitHub workflow).
if (require.main === module) {
  collect().then((r) => {
    const out = process.argv[2];
    const json = JSON.stringify(r, null, 2);
    if (!out) return console.log(json);
    require('fs').writeFileSync(out, json);
    const failed = r.services.filter((s) => s.error);
    console.log(`Wrote ${out}: overall ${r.overall}, ${r.services.length} services`);
    for (const s of failed) console.warn(`::warning::${s.name}: ${s.error}`);
  });
}
