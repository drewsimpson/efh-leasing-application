# Script: APP_GenerateApplicationPDF

**File:** EFH_PM_TenanTTrak_v3
**Called by:** the Cloudflare Worker via Data API script call on layout `API_APPLICATIONS`.
**Parameter:** the `ApplicationNumber` (e.g. `APP-2026-0048`).
**Returns (Exit Script):** JSON — either `{"containerUrl":"<data-api container url>"}` or `{"base64":"<pdf base64>"}`.

The Worker prefers `containerUrl` (it fetches the bytes with the session token) and falls
back to `base64`. Store the PDF in a container field so the Data API can hand back a URL.

## Steps
1. `Set Variable [ $appNo ; Get(ScriptParameter) ]`
2. `Enter Find Mode []` → set `APPLICATIONS::ApplicationNumber` = `$appNo` → `Perform Find []`
   - `If [ Get(FoundCount) = 0 ]` → `Exit Script [ text: "{\"error\":\"not found\"}" ]`
3. `Go to Layout [ "APPLICATION_Print" (APPLICATIONS) ]`  ← existing printed-application layout
4. `Set Variable [ $path ; "$temp/" & $appNo & ".pdf" ]`
5. `Save Records as PDF [ Restore ; With dialog: Off ; "$path" ; Current record ]`
   - Records: **Current record** (the found application).
6. `Insert File [ APPLICATIONS::ApplicationPDF_Container ; "$path" ]`  ← add this container field
   (or `Insert PDF`), so the Data API can return a container URL.
7. `Commit Records/Requests [ With dialog: Off ]`
8. Build the container URL for the Data API response:
   - The Data API exposes container data as a URL in field data. Simplest contract:
     return `{"base64": Base64Encode(APPLICATIONS::ApplicationPDF_Container) }` — reliable and
     avoids a second round-trip. For large PDFs prefer the container-URL route.
   - `Set Variable [ $json ; "{\"base64\":\"" & Base64Encode ( APPLICATIONS::ApplicationPDF_Container ) & "\"}" ]`
9. `Go to Layout [ original layout ]`
10. `Exit Script [ text: $json ]`

## Notes
- Add one **container field** to APPLICATIONS (e.g. `ApplicationPDF_Container`) to hold the render.
- Ensure the **web.api** privilege set has run access to this script and record access to the
  APPLICATIONS table and the `APPLICATION_Print` layout.
- `Save Records as PDF` requires the printed layout to be complete; `APPLICATION_Print` already
  exists in the file.
