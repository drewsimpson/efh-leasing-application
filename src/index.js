// index.js — EFH Hutton Realty leasing application Worker.
// Serves the static form and handles submission: fmrest write → APP_DOCUMENTS + Box
// → FileMaker-generated PDF → Box → applicant email + Slack. Resilient by design:
// the applicant sees success as long as we capture the submission; downstream steps
// are best-effort with a Box JSON fallback so nothing is ever lost.

import { buildFieldData } from "./mapping.js";
import { FileMaker, Box, slackNotify, verifyTurnstile } from "./services.js";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const securityHeaders = (env) => ({
  "content-security-policy":
    `default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; ` +
    `font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self' https://challenges.cloudflare.com; ` +
    `frame-src https://challenges.cloudflare.com; ` +
    `frame-ancestors ${env.PUBLIC_PARENT_ORIGIN || "https://www.efhuttonrealty.com"} https://efhuttonrealty.com`,
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
});

function appNumber() {
  const yr = new Date().getFullYear();
  const n = String(Math.floor(1 + Math.random() * 9999)).padStart(4, "0");
  return `APP-${yr}-${n}`;
}
const DOC_TYPES = ["DL_Front", "DL_Back", "Bank_Statement", "Paystub", "Credit_Report"];

// Lease term options offered on the form (CUSTOM — confirm/adjust this list).
const LEASE_TERMS = ["12 months", "18 months", "24 months", "Month-to-month"];

// GET /api/catalog — live Property + vacant Unit lists from FileMaker for the form dropdowns.
async function handleCatalog(env) {
  const fm = new FileMaker(env);
  try {
    await fm.login();
    const props = await fm.getRecords("API_PROPERTY", { limit: 500 });
    // vacant = no current tenant (c_CurrentTenant empty)
    const vacantUnits = await fm.findRecords("API_UNIT", [{ c_CurrentTenant: "=" }], { limit: 1000 });
    const num = (v) => Number(String(v ?? "").replace(/[^0-9.]/g, "")) || 0;
    const units = vacantUnits
      .map((u) => {
        const rent = num(u.MonthlyRent) || num(u.c_TotalRent);
        const bb = [u.Bedrooms, u.Bathrooms].every((x) => x !== undefined && x !== "")
          ? `${u.Bedrooms}BR/${u.Bathrooms}BA — ` : "";
        return {
          id: u.__pk_UnitID,
          propertyId: u._fk_PropertyID,
          label: `Unit ${u.UnitNumber || ""} — ${bb}$${rent.toLocaleString()}/mo`.replace(" —  —", " —"),
          rent,
        };
      })
      .filter((u) => u.id && u.propertyId);
    const withVacancy = new Set(units.map((u) => u.propertyId));
    const properties = props
      .map((p) => ({ id: p.__pk_PropertyID, name: p.c_DisplayName || p.PropertyName || p.PropertyCode }))
      .filter((p) => p.id && p.name && withVacancy.has(p.id))
      .sort((a, b) => a.name.localeCompare(b.name));
    return json({ ok: true, properties, units, terms: LEASE_TERMS });
  } catch (e) {
    // Never break the form — return empty lists with the terms so the page still renders.
    return json({ ok: false, code: "CATALOG_ERROR", message: String(e.message || e), properties: [], units: [], terms: LEASE_TERMS });
  } finally {
    await fm.logout();
  }
}

async function handleSubmission(request, env, ctx) {
  const ip = request.headers.get("CF-Connecting-IP") || "";
  let payload, files = [];

  const ctype = request.headers.get("content-type") || "";
  if (ctype.includes("multipart/form-data")) {
    const form = await request.formData();
    payload = JSON.parse(form.get("payload") || "{}");
    // files arrive as fields named doc:<adultIndex>:<DocType>
    for (const [key, val] of form.entries()) {
      if (key.startsWith("doc:") && val instanceof File) {
        const [, adultIndex, docType] = key.split(":");
        files.push({ adultIndex: Number(adultIndex), docType, file: val });
      }
    }
  } else {
    payload = await request.json();
  }

  // 1. Turnstile (bot protection)
  if (!(await verifyTurnstile(env, payload?.turnstileToken, ip))) {
    return json({ ok: false, code: "TURNSTILE_FAILED", message: "Verification failed. Please try again." }, 400);
  }

  const applicationNumber = appNumber();
  const primary = payload?.adults?.[0] || {};
  const applicantName = [primary.lastName, primary.firstName].filter(Boolean).join(", ");
  const unitLabel = payload?.application?.unitLabel || payload?.application?.unitId || "";
  const adultCount = payload?.application?.adultCount || payload?.adults?.length || 1;

  const result = { ok: true, applicationNumber, steps: {} };
  const fm = new FileMaker(env);
  const box = new Box(env);

  try {
    // 2. FileMaker: create the APPLICATIONS record (the authoritative capture)
    await fm.login();
    const fieldData = buildFieldData(payload, { applicationNumber, ip });
    const recordId = await fm.createRecord("API_APPLICATIONS", fieldData);
    result.steps.filemaker = { ok: true, recordId };

    // pull back the __pk_ApplicationID for child records (find by ApplicationNumber)
    const appPk = fieldData.ApplicationNumber; // Worker-generated; APP_DOCUMENTS keys off it

    // 3. Box: per-application subfolder
    let boxFolderId, boxFolderUrl;
    try {
      await box.auth();
      const folderName = `${applicationNumber} - ${unitLabel} - ${applicantName || "Applicant"}`.slice(0, 250);
      boxFolderId = await box.createFolder(folderName, env.BOX_NEW_APPS_FOLDER_ID);
      boxFolderUrl = `https://app.box.com/folder/${boxFolderId}`;
      result.steps.box = { ok: true, boxFolderId };
    } catch (e) {
      result.steps.box = { ok: false, error: String(e.message || e) };
    }

    // 4. Documents → Box + APP_DOCUMENTS (first two adults only, enforced client-side too)
    if (boxFolderId) {
      for (const f of files) {
        if (!DOC_TYPES.includes(f.docType)) continue;
        try {
          const bytes = new Uint8Array(await f.file.arrayBuffer());
          const safeName = `${f.docType}_A${f.adultIndex + 1}_${f.file.name}`.replace(/[^\w.\- ]/g, "_");
          const up = await box.uploadFile(safeName, bytes, boxFolderId, f.file.type || "application/octet-stream");
          await fm.createRecord("API_APP_DOCUMENTS", {
            ApplicationNumber: appPk,
            AdultIndex: f.adultIndex + 1,
            AdultName: applicantName,
            DocType: f.docType,
            FileName: f.file.name,
            FileSizeBytes: f.file.size,
            MimeType: f.file.type || "",
            BoxFileID: up.id,
            BoxFileURL: up.url,
          });
        } catch (e) {
          (result.steps.documents ||= []).push({ docType: f.docType, ok: false, error: String(e.message || e) });
        }
      }
    }

    // 5. FileMaker: generate the application PDF from APPLICATION_Print, save to Box
    try {
      const { scriptResult } = await fm.runScript("API_APPLICATIONS", "APP_GenerateApplicationPDF", applicationNumber);
      // Convention: the script returns JSON {"containerUrl": "..."} or {"base64": "..."}
      let pdfBytes = null;
      if (scriptResult) {
        const sr = JSON.parse(scriptResult);
        if (sr.containerUrl) pdfBytes = await fm.getContainer(sr.containerUrl);
        else if (sr.base64) pdfBytes = Uint8Array.from(atob(sr.base64), (c) => c.charCodeAt(0));
      }
      if (pdfBytes && boxFolderId) {
        const up = await box.uploadFile(`${applicationNumber}.pdf`, pdfBytes, boxFolderId, "application/pdf");
        result.steps.pdf = { ok: true, boxFileId: up.id };
      } else {
        result.steps.pdf = { ok: false, error: "No PDF returned by APP_GenerateApplicationPDF" };
      }
    } catch (e) {
      result.steps.pdf = { ok: false, error: String(e.message || e) };
    }

    // 6a. Applicant PDF copy — via FileMaker (reuses Google Workspace SMTP + APP_EmailApplicant)
    try {
      await fm.runScript("API_APPLICATIONS", "APP_EmailApplicant", applicationNumber);
      result.steps.email = { ok: true, via: "filemaker" };
    } catch (e) {
      result.steps.email = { ok: false, error: String(e.message || e) };
    }
  } catch (e) {
    // Authoritative capture failed — do NOT lose the applicant's data.
    result.steps.filemaker = { ok: false, error: String(e.message || e) };
    try {
      await box.auth();
      const bytes = new TextEncoder().encode(JSON.stringify({ receivedAt: new Date().toISOString(), ip, payload }, null, 2));
      await box.uploadFile(`FAILED_${applicationNumber}.json`, bytes, env.BOX_NEW_APPS_FOLDER_ID, "application/json");
      result.steps.fallback = { ok: true, note: "Saved raw submission to Box for manual recovery." };
    } catch (e2) {
      result.steps.fallback = { ok: false, error: String(e2.message || e2) };
    }
  } finally {
    await fm.logout();
  }

  // 6b. Slack — always attempt (team visibility even on partial failure)
  try {
    await slackNotify(env, {
      applicationNumber,
      applicantName,
      unit: unitLabel,
      adultCount,
      boxUrl: result.steps.box?.boxFolderId ? `https://app.box.com/folder/${result.steps.box.boxFolderId}` : null,
    });
    result.steps.slack = { ok: true };
  } catch (e) {
    result.steps.slack = { ok: false, error: String(e.message || e) };
  }

  // Applicant always sees success once we've captured (FM record or Box fallback).
  const captured = result.steps.filemaker?.ok || result.steps.fallback?.ok;
  return json(
    captured
      ? { ok: true, applicationNumber, message: "Application received." }
      : { ok: false, code: "CAPTURE_FAILED", message: "We couldn't submit your application. Please try again shortly." },
    captured ? 200 : 502
  );
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/api/health") {
    return json({
      ok: true,
      service: "efh-leasing-application",
      environment: env.APP_ENV || "development",
      filemakerConfigured: Boolean(env.FM_HOST && env.FM_DATABASE && env.FM_USERNAME && env.FM_PASSWORD),
      boxConfigured: Boolean(env.BOX_CLIENT_ID && env.BOX_CLIENT_SECRET && env.BOX_NEW_APPS_FOLDER_ID),
      slackConfigured: Boolean(env.SLACK_WEBHOOK_URL),
      turnstileConfigured: Boolean(env.TURNSTILE_SECRET),
    });
  }
  if (request.method === "GET" && url.pathname === "/api/catalog") {
    return handleCatalog(env);
  }
  if (url.pathname === "/api/applications" && request.method === "POST") {
    try {
      return await handleSubmission(request, env);
    } catch (e) {
      return json({ ok: false, code: "SERVER_ERROR", message: String(e.message || e) }, 500);
    }
  }
  return json({ ok: false, code: "NOT_FOUND" }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env);
    const assetResponse = await env.ASSETS.fetch(request);
    const headers = new Headers(assetResponse.headers);
    for (const [k, v] of Object.entries(securityHeaders(env))) headers.set(k, v);
    return new Response(assetResponse.body, { status: assetResponse.status, statusText: assetResponse.statusText, headers });
  },
};
