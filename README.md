# EFH Leasing Application — Cloudflare Worker

Backend + static host for the E.F. Hutton Realty rental application. Serves the form
and handles submission: **fmrest write → APP_DOCUMENTS + Box → FileMaker-generated PDF →
Box → applicant email + Slack**. Designed to be resilient — the applicant sees success as
long as the submission is captured (FileMaker record *or* a Box JSON fallback), and every
downstream step is best-effort with per-step status.

## Layout
```
src/index.js     Worker entry: routing, submission orchestration, security headers
src/mapping.js   Flattens the form's structured JSON → flat FileMaker field names (spec v2)
src/services.js  FileMaker (fmrest), Box (CCG), Slack, Turnstile helpers
public/          Static form (index.html) — the approved mockup, wired to POST /api/applications
wrangler.toml    Config + non-secret vars
```

## Prerequisites in FileMaker (EFH_PM_TenanTTrak_v3)
1. Add the fields from **TenantTrack_RentalApp_Schema_BuildSpec_v2.docx** and create **APP_DOCUMENTS**.
2. Create layouts **API_APPLICATIONS** (extended) and **API_APP_DOCUMENTS** for Data API writes.
3. Create the **web.api** account on the **WEB_API** privilege set — see `docs/webapi_account_setup.md`.
4. Create the **APP_GenerateApplicationPDF** script — see `docs/APP_GenerateApplicationPDF_spec.md`.
   (The existing **APP_EmailApplicant** script is reused to email the applicant their PDF copy.)

## Secrets (never commit — `wrangler secret put <NAME>`)
```
FM_USERNAME          web.api
FM_PASSWORD          <web.api password>
BOX_CLIENT_ID        <Box app client id>
BOX_CLIENT_SECRET    <Box app client secret>
BOX_SUBJECT_ID       <Box enterprise id>
SLACK_WEBHOOK_URL    https://hooks.slack.com/services/XXX/YYY/ZZZ
TURNSTILE_SECRET     <Cloudflare Turnstile secret key>
```
Non-secret vars (FM_HOST, FM_DATABASE, BOX_NEW_APPS_FOLDER_ID, etc.) are in `wrangler.toml`.

## Deploy
```
npm i -g wrangler        # if needed
wrangler deploy          # or: git push  → Cloudflare Workers Build auto-deploys
```
Verify: `GET https://efh-leasing-application.<subdomain>.workers.dev/api/health`
should report `filemakerConfigured: true`, `boxConfigured: true`, etc.

## Submission API
`POST /api/applications` — `multipart/form-data`:
- `payload` — JSON string (shape documented at the top of `src/mapping.js`)
- `doc:<adultIndex>:<DocType>` — one part per file; `DocType` ∈
  `DL_Front | DL_Back | Bank_Statement | Paystub | Credit_Report` (adults 0–1 only)

Returns `{ ok, applicationNumber, message }`. The applicant only ever sees a friendly
result; per-step diagnostics are logged server-side.

## Email routing
Applicant PDF copy and team notifications go through **FileMaker** (`APP_EmailApplicant`,
your Google Workspace SMTP). To move email into the Worker instead (e.g. Resend/Gmail API),
replace the `APP_EmailApplicant` call in `src/index.js` step 6a.

## Resilience notes
- No queue/KV/R2 is used yet. If the FileMaker write fails, the raw submission is saved to
  Box as `FAILED_<ref>.json` so nothing is lost. For guaranteed delivery under load, add a
  **Cloudflare Queue** (enqueue on submit, drain to FileMaker with retry) — recommended
  hardening before high traffic.
