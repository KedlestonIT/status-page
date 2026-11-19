# IT Service Status page

A public status page for Microsoft 365, Securly Filter, Securly Classroom, Securly Aware, Arbor MIS, Trelson Exams, SAMpeople and EVOLVE Visits.
It reads each supplier's own status page, so there are no emails to parse and nothing to update by hand.

Hosted free on **GitHub Pages**. A scheduled **GitHub Actions** workflow collects the supplier status about
every 5 minutes, writes `status.json`, and republishes the site.

```
src/index.html                  the page (re-reads status.json every minute)
collector/collect.js            reads and normalises the supplier feeds (no dependencies)
collector/m365-graph.js         Microsoft 365 tenant service health from Microsoft Graph
collector/samples/              made-up Graph data for local preview
.github/workflows/status.yml    scheduled job: collect → publish to GitHub Pages
dev-server.js                   local preview
```

## Where the data comes from

| Card | Source | Notes |
|---|---|---|
| Microsoft 365 | **Our tenant's service health** via Microsoft Graph (`/admin/serviceAnnouncement/healthOverviews` + `/issues`), once the Entra app below is set up. Until then, or if Graph fails: Microsoft's public feed `status.cloud.microsoft/api/feed/mac`. | Lists every M365 service: green healthy, amber advisory, orange incident, red interruption. Public feed = widespread incidents only. |
| Securly Filter | Status.io API for status.securly.com | Uses the **UK** region status. |
| Securly Classroom / Aware | Same Status.io API | An active incident lifts the card to at least "Degraded". |
| Arbor MIS | Reads status.arbor-education.com (Statuspal) | Headline = worst of School MIS / MAT MIS; all Arbor services listed underneath. |
| Trelson Exams | trelson.statuspage.io API (Atlassian Statuspage) | Headline = Assessment (exam lockdown); Class Manager listed underneath. |
| SAMpeople | **Our own availability check** of app.sampeople.co.uk and MySAM staff absence | No supplier status page exists. Down = no response or a server error on two attempts; slow = over 8 s. |
| EVOLVE Visits | **Our own availability check** of evolve.edufocus.co.uk | No supplier status page exists (eduFOCUS has an unconfigured Statuspage). Same rules as above. |

Availability checks only prove the login page loads. They can't see problems behind sign-in, and the checks run from
GitHub's servers (not in school), so a school-only network issue won't show.

If a supplier can't be reached, that card shows "Status unavailable" with a link to the supplier's page,
and the workflow run shows a warning. If the page hasn't been updated for 30 minutes it says so.

## Set up on GitHub (one-off)

1. Create a **public** repository (GitHub Pages is free for public repos; nothing in here is secret, and the Entra sign-in uses no secret).
2. Push this folder to its `main` branch.
3. Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.
4. **Actions** tab → *Update status page* → **Run workflow** (or just push again).
5. The page is live at `https://<account>.github.io/<repo>/`.

Optional custom domain (e.g. `status.yourdomain`): Settings → Pages → Custom domain, plus a CNAME DNS record
pointing at `<account>.github.io`.

### Things to know about GitHub's scheduler

- 5 minutes is the shortest schedule GitHub allows, and runs can start late when GitHub is busy.
- GitHub turns off scheduled workflows in repos with no activity for 60 days. The workflow re-enables itself
  once a day to prevent that. If the page ever says it hasn't updated recently, check the **Actions** tab.
- Usage is free for public repositories.

## Microsoft 365 tenant service health (Entra app registration)

The workflow signs in to Entra as an **app registration** with one read-only Graph permission,
`ServiceHealth.Read.All` (application). It uses **workload identity federation**: Entra trusts the GitHub Actions
job's own short-lived OIDC token, so there is no client secret to store, leak or renew. The browser only ever sees
the finished `status.json`. Until steps 1–2 are done the card keeps using Microsoft's public feed.

A Global Admin does steps 1–2 once.

### 1. App registration, permission, consent, federated credential

PowerShell 7 with the Microsoft Graph module (`Install-Module Microsoft.Graph -Scope CurrentUser`):

```powershell
Connect-MgGraph -TenantId kedlestongroup.com -Scopes 'Application.ReadWrite.All','AppRoleAssignment.ReadWrite.All'

$graph = Get-MgServicePrincipal -Filter "appId eq '00000003-0000-0000-c000-000000000000'"
$role  = $graph.AppRoles | Where-Object { $_.Value -eq 'ServiceHealth.Read.All' -and $_.AllowedMemberTypes -contains 'Application' }

# Single-tenant app registration that requests only ServiceHealth.Read.All
$app = New-MgApplication -DisplayName 'IT Status Page (GitHub Actions)' -SignInAudience AzureADMyOrg `
  -RequiredResourceAccess @{ ResourceAppId = $graph.AppId; ResourceAccess = @(@{ Id = $role.Id; Type = 'Role' }) }
$sp = New-MgServicePrincipal -AppId $app.AppId

# Admin consent: assigns the application permission to the app
New-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $sp.Id -PrincipalId $sp.Id -ResourceId $graph.Id -AppRoleId $role.Id

# Trust GitHub Actions jobs in this repo that deploy to the github-pages environment
New-MgApplicationFederatedIdentityCredential -ApplicationId $app.Id -BodyParameter @{
  Name      = 'github-status-page'
  Issuer    = 'https://token.actions.githubusercontent.com'
  Subject   = 'repo:KedlestonIT@357398062/status-page@1464085338:environment:github-pages'
  Audiences = @('api://AzureADTokenExchange')
}

"AZURE_TENANT_ID = $((Get-MgContext).TenantId)"
"AZURE_CLIENT_ID = $($app.AppId)"
```

Or in the Entra admin centre:

1. **App registrations → New registration**: name *IT Status Page (GitHub Actions)*, *Accounts in this organizational
   directory only*, no redirect URI.
2. **API permissions → Add a permission → Microsoft Graph → Application permissions → ServiceHealth.Read.All → Add
   permissions**, then **Grant admin consent for Kedleston Group**. Remove the default delegated `User.Read`; it isn't needed.
3. **Certificates & secrets → Federated credentials → Add credential → Other issuer**:
   Issuer `https://token.actions.githubusercontent.com`, Type **Explicit subject identifier**,
   Value `repo:KedlestonIT@357398062/status-page@1464085338:environment:github-pages`,
   Audience `api://AzureADTokenExchange`, Name `github-status-page`. The value is case-sensitive.
4. Copy the **Directory (tenant) ID** and **Application (client) ID** from the Overview page.

Why *environment* and not *branch*: the deploy job runs in the `github-pages` environment, and GitHub then puts the
environment, not the branch, in the token's subject. That environment only accepts deployments from `main` by default,
so the effect is the same: only runs from `main` can sign in.

Why the numbers in the subject: this repo uses GitHub's **immutable subject** format, which adds the account ID
(`357398062`) and repo ID (`1464085338`). If the repo is ever deleted and recreated, or the name is taken by someone
else, the IDs change and the old credential stops working, which is the point. The portal's *GitHub Actions* scenario
builds the old name-only subject, so use *Other issuer* as above. To check the current prefix:

```powershell
gh api repos/KedlestonIT/status-page/actions/oidc/customization/sub --jq .sub_claim_prefix
```

If sign-in fails with AADSTS700213, the workflow warning shows the exact subject GitHub sent; make the credential match it.

### 2. Repo variables

IDs aren't secret, so they're **variables**: repo **Settings → Secrets and variables → Actions → Variables**, or:

```powershell
gh variable set AZURE_TENANT_ID --repo KedlestonIT/status-page --body '<tenant ID>'
```

```powershell
gh variable set AZURE_CLIENT_ID --repo KedlestonIT/status-page --body '<application (client) ID>'
```

```powershell
gh variable set M365_DETAIL --repo KedlestonIT/status-page --body 'services'
```

| `M365_DETAIL` | What the published `status.json` contains |
|---|---|
| `services` (default) | Each M365 service and its colour, plus one line per affected service, e.g. "Microsoft is reporting 1 incident affecting Exchange Online". No issue IDs, titles or descriptions. |
| `full` | Also each issue's ID (e.g. EX912345), title, impact description, start and last update. Only if the page is **not** public (next section). |

Then **Actions → Update status page → Run workflow**. The log should say
`Microsoft 365 source: tenant service health (Graph)`. If sign-in fails, the run shows a warning with the Entra error
(log only, never in `status.json`) and the card falls back to the public feed with a note.

**Fallback if federation can't be used:** add a client secret to the app (shortest expiry you can live with) and store it
as the repo **secret** `AZURE_CLIENT_SECRET`. It's only used when there's no OIDC token. Diary the expiry.

### Who can see the page

GitHub Pages on the Free/Team plan is **public to the whole internet**, and `status.json` can be read by anyone with
the URL. Options:

| Option | Cost / effort | Notes |
|---|---|---|
| **Public, `M365_DETAIL=services`** (default) | None | Reveals only which Microsoft services have an advisory or incident for our tenant. No issue text. |
| GitHub Enterprise Cloud **private Pages** | Enterprise licence | Restricted to org members; every viewer needs a GitHub account, so not practical for school offices. |
| **Azure Static Web Apps** with Entra sign-in | Standard plan (about $9/month) to lock it to our tenant | Same `site/` output; swap the two Pages steps for `Azure/static-web-apps-deploy`. Staff are already signed in via SSO, so the SharePoint embed still works. Allows `full`. |
| **Inside SharePoint** | SPFx web part | SharePoint downloads `.html` files instead of rendering them, so this needs a small SPFx web part that reads `status.json`. Most private, most work. |

## Show it in Teams and SharePoint

- **Teams channel tab:** channel → **+** → **Website** → paste the page URL.
- **Pinned for all staff:** package a Teams app (manifest + icons) that opens the URL, upload it in the
  Teams admin centre, and pin it with an app setup policy.
- **SharePoint page** (once per site collection; needs Site Owner):
  1. On the intranet site: **Settings (cog) → Site information → View all site settings → Site Collection
     Administration → HTML Field Security**.
  2. Choose *Allow contributors to insert iframes from the following domains*, type `kedlestonit.github.io`
     (or your custom domain), **Add**, **OK**.
  3. Edit the page → **+** → **Embed** → paste:
     `<iframe src="https://kedlestonit.github.io/status-page/" width="100%" height="900" title="IT service status"></iframe>`
  4. Republish. If the web part says embedding isn't allowed, the domain in step 2 doesn't match the URL exactly.

  The page follows the viewer's light/dark setting and reflows down to phone width, so it sits cleanly in a
  one-column section.

## Run locally

```powershell
node dev-server.js
```

Open http://localhost:4280. To see the raw data: `node collector/collect.js`.

Preview the Microsoft 365 card with made-up Graph data (no tenant access needed):

```powershell
$env:M365_SAMPLE = '1'; $env:M365_DETAIL = 'full'; node dev-server.js
```

Set `$env:M365_DETAIL = 'services'` to see exactly what the public page will show.

## Adding another service

Write an `async` function (in `collector/collect.js`, or its own file like `m365-graph.js`) that returns an array of
cards in the same shape as the others: `id, name, vendor, status, statusText, scope, components, incidents, upcoming,
url, updated`, where `status` is one of `operational, maintenance, degraded, partial, outage, unknown`. Add it to
`SOURCES`. The page needs no changes. Credentials go in repo secrets/variables, passed in the workflow's
*Collect supplier status* step `env:`, and never into `status.json`.
