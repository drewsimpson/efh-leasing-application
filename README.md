# EF Hutton Realty Leasing Application

Replacement web application for the Greenways Condominiums Claris Studio leasing workflow.

## Architecture

- Public website entry: `https://www.efhuttonrealty.com/leasingwebapp.html`
- Application hosting: Cloudflare Workers + Static Assets
- Backend: Cloudflare Worker API
- System of record: Claris FileMaker Server / Data API
- Application records: `APPLICATIONS`
- Related uploads: `APP_DOCUMENTS`

## Current build status

Initial scaffold only. The first two Studio pages are represented in the frontend so the deployment and responsive UI can be established while the remaining Studio pages and field mappings are inventoried.

Production FileMaker writes and document uploads are intentionally disabled until the final FileMaker field map, API layouts, and required web-security fields are confirmed.

Cloudflare Git deployment trigger verified after repository connection on 2026-08-28.

## Local development

```bash
npm install
npm run dev
```

## Cloudflare deployment

```bash
npm run deploy
```

Cloudflare configuration is in `wrangler.toml`.

## Required production secrets

Do not commit these values to GitHub.

```text
FM_HOST
FM_DATABASE
FM_USERNAME
FM_PASSWORD
```

They should be configured as Cloudflare Worker secrets/variables.

## Planned API

```text
GET    /api/health
POST   /api/applications
PATCH  /api/applications/:resumeToken
GET    /api/applications/:resumeToken
POST   /api/applications/:resumeToken/documents
DELETE /api/applications/:resumeToken/documents/:documentToken
POST   /api/applications/:resumeToken/submit
```

## Planned FileMaker document relationship

```text
APPLICATIONS::_pk_ApplicationID
    =
APP_DOCUMENTS::_fk_ApplicationID
```

`ApplicationID` remains the human-readable application number and is not used as the relational key.
