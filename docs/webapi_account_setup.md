# web.api account setup — EFH_PM_TenanTTrak_v3

Create a dedicated least-privilege account for the Cloudflare Worker. Do **not** ship the
`cs.api` `[Full Access]` login in a public Worker.

## 1. Privilege set — WEB_API (already exists; configure it)
Manage → Security → Advanced → **Privilege Sets** → edit **WEB_API**:
- **Extended Privileges:** check **Access via FileMaker Data API (fmrest)**. (Leave fmapp/fmodata off unless needed.)
- **Records:** Custom → **Create & Edit** on `APPLICATIONS` and `APP_DOCUMENTS`; **View** on
  `PROPERTY`, `UNIT` (for pickers). No access to other tables.
- **Layouts:** minimum — allow `API_APPLICATIONS`, `API_APP_DOCUMENTS`, and `APPLICATION_Print`
  (needed by the PDF script). "All view only" is acceptable if simpler.
- **Scripts:** allow execution of `APP_GenerateApplicationPDF` and `APP_EmailApplicant`.
- Other privileges: leave management/export off.

## 2. Account
Manage → Security → **Accounts** → **New**:
- **Authenticate via:** FileMaker File
- **Account Name:** `web.api`
- **Password:** set a strong value (store in 1Password + set as the `FM_PASSWORD` Worker secret)
- **Privilege Set:** `WEB_API`
- **Active:** ✓

## 3. Wire the secrets
```
wrangler secret put FM_USERNAME     # web.api
wrangler secret put FM_PASSWORD     # <the password you just set>
```

## 4. Verify
`GET /api/health` → `filemakerConfigured: true`. Then a test submission (or the Worker's
Data API round-trip) should create a record on `API_APPLICATIONS` and run the PDF script
without a 212/9 error.
