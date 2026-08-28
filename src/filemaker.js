function requireConfig(env) {
  const required = ["FM_HOST", "FM_DATABASE", "FM_USERNAME", "FM_PASSWORD"];
  const missing = required.filter((key) => !env[key]);
  if (missing.length) throw new Error(`Missing FileMaker configuration: ${missing.join(", ")}`);
}

function baseUrl(env) {
  return `${env.FM_HOST.replace(/\/$/, "")}/fmi/data/vLatest/databases/${encodeURIComponent(env.FM_DATABASE)}`;
}

async function parseFileMakerResponse(response) {
  const payload = await response.json().catch(() => null);
  const message = payload?.messages?.[0];
  if (!response.ok || (message && message.code !== "0")) {
    const error = new Error(message?.message || `FileMaker request failed with HTTP ${response.status}`);
    error.code = message?.code || String(response.status);
    throw error;
  }
  return payload;
}

export async function openSession(env) {
  requireConfig(env);
  const credentials = btoa(`${env.FM_USERNAME}:${env.FM_PASSWORD}`);
  const response = await fetch(`${baseUrl(env)}/sessions`, {
    method: "POST",
    headers: {
      authorization: `Basic ${credentials}`,
      "content-type": "application/json",
    },
    body: "{}",
  });
  const payload = await parseFileMakerResponse(response);
  return payload.response.token;
}

export async function closeSession(env, token) {
  if (!token) return;
  await fetch(`${baseUrl(env)}/sessions/${encodeURIComponent(token)}`, {
    method: "DELETE",
  }).catch(() => null);
}

export async function withSession(env, callback) {
  const token = await openSession(env);
  try {
    return await callback(token);
  } finally {
    await closeSession(env, token);
  }
}

export async function createRecord(env, token, layout, fieldData) {
  const response = await fetch(`${baseUrl(env)}/layouts/${encodeURIComponent(layout)}/records`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ fieldData }),
  });
  return parseFileMakerResponse(response);
}

export async function editRecord(env, token, layout, recordId, fieldData) {
  const response = await fetch(
    `${baseUrl(env)}/layouts/${encodeURIComponent(layout)}/records/${encodeURIComponent(recordId)}`,
    {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ fieldData }),
    }
  );
  return parseFileMakerResponse(response);
}

export async function uploadContainer(env, token, layout, recordId, fieldName, file, fileName) {
  const form = new FormData();
  form.append("upload", file, fileName || file.name || "upload.bin");

  const response = await fetch(
    `${baseUrl(env)}/layouts/${encodeURIComponent(layout)}/records/${encodeURIComponent(recordId)}/containers/${encodeURIComponent(fieldName)}/1`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: form,
    }
  );
  return parseFileMakerResponse(response);
}
