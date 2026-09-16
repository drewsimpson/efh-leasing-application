// services.js — FileMaker Data API, Box, Slack, and Turnstile helpers.

/* ----------------------------- FileMaker (fmrest) ----------------------------- */
export class FileMaker {
  constructor(env) {
    this.base = `https://${env.FM_HOST}/fmi/data/vLatest/databases/${encodeURIComponent(env.FM_DATABASE)}`;
    this.user = env.FM_USERNAME;
    this.pass = env.FM_PASSWORD;
    this.token = null;
  }
  async login() {
    const r = await fetch(`${this.base}/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic " + btoa(`${this.user}:${this.pass}`),
      },
      body: "{}",
    });
    const j = await r.json();
    const code = j?.messages?.[0]?.code;
    if (code !== "0" || !j?.response?.token) {
      throw new Error(`FM login failed (${code}): ${j?.messages?.[0]?.message || r.status}`);
    }
    this.token = j.response.token;
    return this.token;
  }
  async logout() {
    if (!this.token) return;
    try {
      await fetch(`${this.base}/sessions/${this.token}`, { method: "DELETE" });
    } catch (_) {}
    this.token = null;
  }
  headers() {
    return { "Content-Type": "application/json", Authorization: `Bearer ${this.token}` };
  }
  async createRecord(layout, fieldData) {
    const r = await fetch(`${this.base}/layouts/${encodeURIComponent(layout)}/records`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ fieldData }),
    });
    const j = await r.json();
    const code = j?.messages?.[0]?.code;
    if (code !== "0") throw new Error(`FM create on ${layout} failed (${code}): ${j?.messages?.[0]?.message}`);
    return j.response.recordId;
  }
  async getRecord(layout, recordId) {
    const r = await fetch(`${this.base}/layouts/${encodeURIComponent(layout)}/records/${encodeURIComponent(recordId)}`, { headers: this.headers() });
    const j = await r.json();
    const code = j?.messages?.[0]?.code;
    if (code !== "0") throw new Error(`FM get record failed (${code})`);
    return j.response.data[0].fieldData;
  }
  async uploadContainer(layout, recordId, field, file) {
    const form = new FormData();
    form.append("upload", file, file.name);
    const r = await fetch(`${this.base}/layouts/${encodeURIComponent(layout)}/records/${encodeURIComponent(recordId)}/containers/${encodeURIComponent(field)}/1`, {
      method: "POST", headers: { Authorization: `Bearer ${this.token}` }, body: form,
    });
    const j = await r.json();
    const code = j?.messages?.[0]?.code;
    if (code !== "0") throw new Error(`FM container upload failed (${code})`);
  }
  // Run a server-side script; returns { scriptResult, scriptError }.
  async runScript(layout, scriptName, param) {
    const url =
      `${this.base}/layouts/${encodeURIComponent(layout)}/script/${encodeURIComponent(scriptName)}` +
      (param != null ? `?script.param=${encodeURIComponent(param)}` : "");
    const r = await fetch(url, { method: "GET", headers: this.headers() });
    const j = await r.json();
    const code = j?.messages?.[0]?.code;
    if (code !== "0") throw new Error(`FM script ${scriptName} failed (${code}): ${j?.messages?.[0]?.message}`);
    return { scriptResult: j?.response?.scriptResult, scriptError: j?.response?.scriptError };
  }
  // Get up to `limit` records' fieldData from a layout.
  async getRecords(layout, { limit = 200 } = {}) {
    const r = await fetch(
      `${this.base}/layouts/${encodeURIComponent(layout)}/records?_limit=${limit}`,
      { headers: this.headers() }
    );
    const j = await r.json();
    const code = j?.messages?.[0]?.code;
    if (code === "401") return []; // no records
    if (code !== "0") throw new Error(`FM getRecords ${layout} failed (${code}): ${j?.messages?.[0]?.message}`);
    return (j.response?.data || []).map((d) => d.fieldData);
  }
  // Find records (query is an array of FileMaker find requests).
  async findRecords(layout, query, { limit = 200 } = {}) {
    const r = await fetch(`${this.base}/layouts/${encodeURIComponent(layout)}/_find`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ query, limit }),
    });
    const j = await r.json();
    const code = j?.messages?.[0]?.code;
    if (code === "401") return []; // no records match
    if (code !== "0") throw new Error(`FM find ${layout} failed (${code}): ${j?.messages?.[0]?.message}`);
    return (j.response?.data || []).map((d) => d.fieldData);
  }
  // Fetch a container's bytes (the Data API returns a temporary URL in field data).
  async getContainer(url) {
    if (new URL(url).origin !== new URL(this.base).origin) throw new Error("Unexpected container origin");
    const headers = { Authorization: `Bearer ${this.token}` };
    let r = await fetch(url, { headers, redirect: "manual" });
    // Streaming authentication can issue a cookie on its initial 401 response.
    if (r.status === 401) {
      const cookies = typeof r.headers.getSetCookie === "function"
        ? r.headers.getSetCookie() : [r.headers.get("set-cookie")].filter(Boolean);
      if (cookies.length) {
        headers.Cookie = cookies.map(c => c.split(";")[0]).join("; ");
        r = await fetch(url, { headers, redirect: "manual" });
      }
    }
    if (!r.ok) throw new Error(`FM container fetch failed: ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  }
}

/* --------------------------------- Box --------------------------------------- */
export class Box {
  constructor(env) {
    this.env = env;
    this.token = null;
  }
  // Client Credentials Grant — service account, no user interaction.
  async auth() {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.env.BOX_CLIENT_ID,
      client_secret: this.env.BOX_CLIENT_SECRET,
      box_subject_type: this.env.BOX_SUBJECT_TYPE || "enterprise",
      box_subject_id: this.env.BOX_SUBJECT_ID,
    });
    const r = await fetch("https://api.box.com/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const j = await r.json();
    if (!j.access_token) throw new Error(`Box auth failed: ${JSON.stringify(j).slice(0, 200)}`);
    this.token = j.access_token;
  }
  async createFolder(name, parentId) {
    const r = await fetch("https://api.box.com/2.0/folders", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name, parent: { id: String(parentId) } }),
    });
    if (r.status === 409) {
      // already exists — find it
      const conflict = await r.json();
      const existing = conflict?.context_info?.conflicts?.[0]?.id;
      if (existing) return existing;
    }
    const j = await r.json();
    if (!j.id) throw new Error(`Box folder create failed: ${JSON.stringify(j).slice(0, 200)}`);
    return j.id;
  }
  async uploadFile(name, bytes, parentId, contentType = "application/octet-stream") {
    const form = new FormData();
    form.append(
      "attributes",
      JSON.stringify({ name, parent: { id: String(parentId) } })
    );
    form.append("file", new Blob([bytes], { type: contentType }), name);
    const r = await fetch("https://upload.box.com/api/2.0/files/content", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}` },
      body: form,
    });
    const j = await r.json();
    const entry = j?.entries?.[0];
    if (!entry?.id) throw new Error(`Box upload failed for ${name}: ${JSON.stringify(j).slice(0, 200)}`);
    return { id: entry.id, url: `https://app.box.com/file/${entry.id}` };
  }
}

/* -------------------------------- Slack -------------------------------------- */
export async function slackNotify(env, { applicationNumber, applicantName, unit, adultCount, boxUrl }) {
  if (!env.SLACK_WEBHOOK_URL) return;
  const text = `:house: New rental application *${applicationNumber}*`;
  const blocks = [
    { type: "section", text: { type: "mrkdwn", text: `:house: *New rental application received*` } },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Ref:*\n${applicationNumber}` },
        { type: "mrkdwn", text: `*Applicant:*\n${applicantName || "—"}` },
        { type: "mrkdwn", text: `*Unit:*\n${unit || "—"}` },
        { type: "mrkdwn", text: `*Adults:*\n${adultCount}` },
      ],
    },
  ];
  if (boxUrl) blocks.push({ type: "section", text: { type: "mrkdwn", text: `<${boxUrl}|Open documents in Box>` } });
  await fetch(env.SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, blocks }),
  });
}

/* ------------------------------ Turnstile ------------------------------------ */
export async function verifyTurnstile(env, token, ip) {
  if (!env.TURNSTILE_SECRET) return true; // not enforced if unset
  const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token || "" });
  if (ip) form.append("remoteip", ip);
  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: form,
  });
  const j = await r.json();
  return !!j.success;
}
