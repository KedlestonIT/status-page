# IT Service Status page

A public status page for Microsoft 365, Securly Filter, Securly Classroom, Securly Aware and Arbor MIS.
It reads each supplier's own status page, so there are no emails to parse and nothing to update by hand.

Hosted free on **GitHub Pages**. A scheduled **GitHub Actions** workflow collects the supplier status about
every 5 minutes, writes `status.json`, and republishes the site.

```
src/index.html                  the page (re-reads status.json every minute)
collector/collect.js            reads and normalises the supplier feeds (no dependencies)
.github/workflows/status.yml    scheduled job: collect → publish to GitHub Pages
dev-server.js                   local preview
```

## Where the data comes from

| Card | Source | Notes |
|---|---|---|
| Microsoft 365 | `status.cloud.microsoft/api/feed/mac` (public RSS) | Widespread incidents only; tenant-specific issues won't show. |
| Securly Filter | Status.io API for status.securly.com | Uses the **UK** region status. |
| Securly Classroom / Aware | Same Status.io API | An active incident lifts the card to at least "Degraded". |
| Arbor MIS | Reads status.arbor-education.com (Statuspal) | Headline = worst of School MIS / MAT MIS; all Arbor services listed underneath. |

If a supplier can't be reached, that card shows "Status unavailable" with a link to the supplier's page,
and the workflow run shows a warning. If the page hasn't been updated for 30 minutes it says so.

## Set up on GitHub (one-off)

1. Create a **public** repository (GitHub Pages is free for public repos; nothing in here is secret).
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

## Show it in Teams and SharePoint

- **Teams channel tab:** channel → **+** → **Website** → paste the page URL.
- **Pinned for all staff:** package a Teams app (manifest + icons) that opens the URL, upload it in the
  Teams admin centre, and pin it with an app setup policy.
- **SharePoint page:** add the page's domain (`<account>.github.io` or your custom domain) under
  Site settings → **HTML Field Security**, then use the **Embed** web part:
  `<iframe src="https://<account>.github.io/<repo>/" width="100%" height="900"></iframe>`

## Run locally

```bash
node dev-server.js
```

Open http://localhost:4280. To see the raw data: `node collector/collect.js`.
