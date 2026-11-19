// Microsoft 365 service health for OUR tenant, from Microsoft Graph's service communications API.
//   GET /admin/serviceAnnouncement/healthOverviews   (status of each service)
//   GET /admin/serviceAnnouncement/issues            (advisories and incidents)
// Needs an Entra app registration with the application permission ServiceHealth.Read.All (read-only).
//
// Sign-in, in order of preference:
//   1. GitHub Actions OIDC (workload identity federation) - no secret anywhere.
//   2. AZURE_CLIENT_SECRET - only if federation can't be used.
//   3. M365_SAMPLE=1 - reads collector/samples/m365-graph.json instead of calling Graph (local preview).
//
// M365_DETAIL controls what is published:
//   services (default) - each service's colour, plus one generic line per affected service. No issue text.
//   full               - also the issue ID, title, impact description and last update.

const fs = require('fs');
const path = require('path');

const GRAPH = 'https://graph.microsoft.com/v1.0/admin/serviceAnnouncement';
const M365_PAGE = 'https://status.cloud.microsoft';

const env = (k) => (process.env[k] || '').trim();
const isConfigured = () => env('M365_SAMPLE') === '1' || (env('AZURE_TENANT_ID') && env('AZURE_CLIENT_ID'));

async function json(url, opts = {}) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(15000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Entra/Graph error text never contains the secret or token, so it's safe to surface.
    const why = body.error_description?.split('\r\n')[0] || body.error?.message || body.error || '';
    throw new Error(`${new URL(url).host} returned HTTP ${res.status} ${why}`.trim());
  }
  return body;
}

async function githubOidcToken() {
  const url = env('ACTIONS_ID_TOKEN_REQUEST_URL');
  const token = env('ACTIONS_ID_TOKEN_REQUEST_TOKEN');
  if (!url || !token) return null; // not running in Actions, or the job lacks `id-token: write`
  const r = await json(`${url}&audience=${encodeURIComponent('api://AzureADTokenExchange')}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return r.value;
}

async function graphToken() {
  const form = new URLSearchParams({
    client_id: env('AZURE_CLIENT_ID'),
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const assertion = await githubOidcToken();
  if (assertion) {
    form.set('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
    form.set('client_assertion', assertion);
  } else if (env('AZURE_CLIENT_SECRET')) {
    form.set('client_secret', env('AZURE_CLIENT_SECRET'));
  } else {
    throw new Error('No GitHub OIDC token and no AZURE_CLIENT_SECRET, so cannot sign in to Entra');
  }
  const r = await json(`https://login.microsoftonline.com/${env('AZURE_TENANT_ID')}/oauth2/v2.0/token`, {
    method: 'POST',
    body: form,
  });
  return r.access_token;
}

async function graphAll(url, token, maxPages = 20) {
  const out = [];
  for (let i = 0; url && i < maxPages; i++) {
    const r = await json(url, { headers: { Authorization: `Bearer ${token}` } });
    out.push(...(r.value || []));
    url = r['@odata.nextLink'];
  }
  return out;
}

async function fetchGraph() {
  if (env('M365_SAMPLE') === '1') {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'samples', 'm365-graph.json'), 'utf8'));
  }
  const token = await graphToken();
  const [overviews, issues] = await Promise.all([
    graphAll(`${GRAPH}/healthOverviews?$select=id,service,status`, token),
    graphAll(`${GRAPH}/issues?$top=100&$select=id,title,impactDescription,classification,status,service,feature,isResolved,startDateTime,lastModifiedDateTime`, token),
  ]);
  // Diagnostics for the workflow log (public on a public repo): counts and status codes only, no issue text.
  const unresolved = issues.filter((i) => !i.isResolved);
  console.log(`Graph: ${overviews.length} services, ${issues.length} issues (${unresolved.length} unresolved)`);
  for (const o of overviews.filter((o) => !HEALTHY.has(o.status))) {
    const mine = issues.filter((i) => i.service === o.service);
    const tally = {};
    for (const i of mine) {
      const k = `${i.classification}/${i.status}/${i.isResolved ? 'resolved' : 'open'}`;
      tally[k] = (tally[k] || 0) + 1;
    }
    console.log(`  ${o.service} [${o.id}] overview=${o.status} issues=${JSON.stringify(tally)}`);
  }
  const names = new Set(overviews.map((o) => o.service));
  const orphan = [...new Set(unresolved.map((i) => i.service).filter((s) => !names.has(s)))];
  if (orphan.length) console.log(`  unresolved issues on services not in overviews: ${orphan.join(', ')}`);
  return { overviews, issues };
}

// ---------- normalising ----------
// Graph serviceHealthStatus values: https://learn.microsoft.com/graph/api/resources/servicehealthissue
const HEALTHY = new Set([
  'serviceOperational', 'serviceRestored', 'falsePositive', 'resolved', 'resolvedExternal',
  'postIncidentReviewPublished', 'mitigated', 'mitigatedExternal', 'investigationSuspended',
]);
const RANK = { operational: 0, degraded: 2, partial: 3, outage: 4 };
const max = (a, b) => (RANK[b] > RANK[a] ? b : a);
// Our page colours: healthy = green, advisory = amber, incident = orange, interruption = red.
const TEXT = { operational: 'Healthy', degraded: 'Advisory', partial: 'Incident', outage: 'Service interruption' };

function overviewLevel(status) {
  if (status === 'serviceInterruption') return 'outage';
  if (status === 'serviceDegradation') return 'partial';
  return HEALTHY.has(status) ? 'operational' : 'degraded';
}

function issueLevel(i) {
  if (i.status === 'serviceInterruption') return 'outage';
  return i.classification === 'incident' ? 'partial' : 'degraded';
}

const isActive = (i) => !i.isResolved && !HEALTHY.has(i.status);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function normalise({ overviews, issues }, detail = env('M365_DETAIL') || 'services') {
  const full = detail === 'full';
  const active = issues.filter(isActive);

  const components = overviews.map((o) => {
    const mine = active.filter((i) => i.service === o.service);
    const status = mine.map(issueLevel).reduce(max, overviewLevel(o.status));
    const inc = mine.filter((i) => i.classification === 'incident').length;
    const adv = mine.length - inc;
    const counts = [inc && plural(inc, 'incident'), adv && plural(adv, 'advisory').replace('advisorys', 'advisories')]
      .filter(Boolean).join(', ');
    return { name: o.service, status, statusText: status !== 'outage' && counts ? counts[0].toUpperCase() + counts.slice(1) : TEXT[status], _issues: mine, _counts: counts };
  }).sort((a, b) => RANK[b.status] - RANK[a.status] || a.name.localeCompare(b.name));

  const incidents = full
    ? active
      .map((i) => ({
        kind: 'incident',
        title: `${i.service}: ${i.title}`,
        ref: i.id,
        status: issueLevel(i),
        statusText: i.classification === 'incident' ? 'Incident' : 'Advisory',
        started: i.startDateTime,
        updated: i.lastModifiedDateTime,
        message: i.impactDescription || '',
        url: null, // the admin centre link only works for admins
      }))
      .sort((a, b) => RANK[b.status] - RANK[a.status] || (b.updated || '').localeCompare(a.updated || ''))
    : components
      .filter((c) => c.status !== 'operational')
      .map((c) => ({
        kind: 'incident',
        title: c.name,
        status: c.status,
        statusText: TEXT[c.status],
        updated: c._issues.map((i) => i.lastModifiedDateTime).sort().at(-1) || null,
        message: `Microsoft is reporting ${c._counts || 'a problem'} affecting ${c.name}. Contact IT if this is stopping you working.`,
        url: null,
      }));

  const status = components.map((c) => c.status).reduce(max, 'operational');
  const affected = components.filter((c) => c.status !== 'operational').length;
  return {
    id: 'm365',
    name: 'Microsoft 365',
    vendor: 'Microsoft',
    status,
    statusText: affected ? `${TEXT[status]} · ${plural(affected, 'service')} affected` : 'All services healthy',
    scope: 'Our tenant, from Microsoft 365 service health',
    components: components.map(({ _issues, _counts, ...c }) => c),
    componentLabel: 'services',
    incidents,
    upcoming: [],
    url: M365_PAGE,
    updated: issues.map((i) => i.lastModifiedDateTime).filter(Boolean).sort().at(-1) || null,
  };
}

async function m365Graph() {
  return [normalise(await fetchGraph())];
}

module.exports = { m365Graph, isConfigured, normalise };
