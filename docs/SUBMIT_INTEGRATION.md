# Front-end submit integration

`public/index.html` is the approved mockup (brand-matched). Its submit currently runs the
**simulated** pipeline. To go live, two things:

1. **Give inputs a data identity** so they can be serialized. The mockup renders sections
   dynamically; add `data-field` attributes (or `name`s) to each input following the payload
   shape in `src/mapping.js`, e.g. `data-adult="0" data-group="residence" data-index="0"
   data-field="address"`. Documents already use the file inputs in each `.drop`.

2. **Replace the simulated submit** with a real POST. Drop-in handler:

```js
async function submitApplication() {
  const payload = collectPayload();               // build the object in mapping.js's shape
  payload.turnstileToken = window.turnstile?.getResponse?.() || "";

  const form = new FormData();
  form.append("payload", JSON.stringify(payload));
  // attach files: iterate the document drop zones for adults 0 and 1
  document.querySelectorAll('[data-step="applicant"]').forEach((sec) => {
    const idx = +sec.getAttribute("data-idx");
    if (idx > 1) return;                            // docs only for first two adults
    sec.querySelectorAll("[data-drop]").forEach((d) => {
      const docType = d.getAttribute("data-doctype"); // add data-doctype to each drop
      [...(d.querySelector('input[type=file]')?.files || [])].forEach((file) =>
        form.append(`doc:${idx}:${docType}`, file, file.name)
      );
    });
  });

  const res = await fetch("/api/applications", { method: "POST", body: form });
  const json = await res.json();
  if (json.ok) showSuccess(json.applicationNumber);  // your existing done screen
  else showError(json.message);
}
```

3. **Turnstile widget** — add before submit (bot protection):
```html
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
<div class="cf-turnstile" data-sitekey="YOUR_TURNSTILE_SITE_KEY"></div>
```
The CSP in `src/index.js` already allows `challenges.cloudflare.com` for script/connect/frame.

## Document drop zones
Add `data-doctype` to each `.drop` so files map to the right `DocType`:
`DL_Front`, `DL_Back`, `Bank_Statement`, `Paystub` (the income drop can tag both — let the
applicant pick, or default `Bank_Statement`), `Credit_Report`.

## Notes
- Keep the "documents only for first two adults" rule on the client (already visual) — the
  Worker also enforces it.
- `collectPayload()` is the one function you write; everything downstream (field mapping,
  fmrest, Box, PDF, email, Slack) is already implemented server-side.
