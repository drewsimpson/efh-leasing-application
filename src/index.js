const json = (data, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });

const securityHeaders = (env) => ({
  "content-security-policy": `default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors ${env.PUBLIC_PARENT_ORIGIN || "https://www.efhuttonrealty.com"} https://efhuttonrealty.com`,
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
});

async function handleApi(request, env, url) {
  if (request.method === "GET" && url.pathname === "/api/health") {
    return json({
      ok: true,
      service: "efh-leasing-application",
      environment: env.APP_ENV || "development",
      filemakerConfigured: Boolean(
        env.FM_HOST && env.FM_DATABASE && env.FM_USERNAME && env.FM_PASSWORD
      ),
    });
  }

  // These routes are reserved now so the frontend contract remains stable.
  // FileMaker writes will be enabled after the Studio field inventory and
  // API layouts are finalized.
  if (url.pathname.startsWith("/api/applications")) {
    return json(
      {
        ok: false,
        code: "API_NOT_ENABLED",
        message: "Application persistence is not enabled in this scaffold yet.",
      },
      501
    );
  }

  return json({ ok: false, code: "NOT_FOUND" }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url);
    }

    const assetResponse = await env.ASSETS.fetch(request);
    const headers = new Headers(assetResponse.headers);
    for (const [key, value] of Object.entries(securityHeaders(env))) {
      headers.set(key, value);
    }

    return new Response(assetResponse.body, {
      status: assetResponse.status,
      statusText: assetResponse.statusText,
      headers,
    });
  },
};
