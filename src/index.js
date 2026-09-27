// index.js — EFH Hutton Realty leasing application Worker.
// Serves the static form and handles submission: fmrest write → APP_DOCUMENTS + Box
// → FileMaker-generated PDF → Box → applicant email + Slack. Resilient by design:
// the applicant sees success as long as we capture the submission; downstream steps
// are best-effort with a Box JSON fallback so nothing is ever lost.

import { buildFieldData } from "./mapping.js";
import { FileMaker, Box, slackNotify, verifyTurnstile } from "./services.js";
import { validateContainerTest, runContainerTest } from "./container-test.js";
import { createApplicationDocuments } from "./documents.js";

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
const BACKFILL_APPLICATIONS = new Set([
  "APP-2026-3943", "APP-2026-9572", "APP-2026-7202",
  "APP-2026-8415", "APP-2026-7734", "APP-2026-6807",
]);
const BACKFILL_TOKEN_SHA256 = "219034bf8dc8fe94ec1d8de96e961ad787c09835996ed7c72784dcd1940e1303";

// Lease term options offered on the form.
const LEASE_TERMS = ["6 months", "12 months", "18 months"];

// Per-property hero image, served from the Worker's static assets (keyed by PropertyCode).
// Drop a photo at public/img/props/<CODE>.<ext> and add its path here.
const PROPERTY_IMAGES = { GRN730: "/img/props/GRN730.webp" };

// GET /api/catalog — live Property + vacant Unit lists from FileMaker for the form dropdowns.
async function handleCatalog(env) {
  const fm = new FileMaker(env);
  try {
    await fm.login();
    const props = await fm.getRecords("API_PROPERTY", { limit: 500 });
    // Available = officially Vacant AND no tenant assigned. Using OccupancyStatus (the
    // authoritative field the vacate/occupy scripts set) excludes units already booked or
    // with a future move-in — those keep a _fk_TenantID even when c_CurrentTenant reads empty.
    const vacantUnits = await fm.findRecords("API_UNIT", [{ OccupancyStatus: "==Vacant", _fk_TenantID: "=" }], { limit: 1000 });
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
      .map((p) => ({
        id: p.__pk_PropertyID,
        name: p.PropertyName || p.c_DisplayName || p.PropertyCode,
        image: PROPERTY_IMAGES[p.PropertyCode] || null,
      }))
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
  const filemakerOnly = payload?.testMode === "filemaker-only"
    && String(primary.otherNames || "").startsWith("TEST-LEASE-");
  const containerTest = payload?.testMode === "filemaker-containers";
  let testSignature;
  if (containerTest) {
    try { testSignature = validateContainerTest(payload, files); }
    catch (_) { return json({ ok: false, code: "INVALID_CONTAINER_TEST" }, 400); }
  }

  const result = { ok: true, applicationNumber, steps: {} };
  const fm = new FileMaker(env);
  const box = new Box(env);

  try {
    // 2. FileMaker: create the APPLICATIONS record (the authoritative capture)
    await fm.login();
    const fieldData = buildFieldData(payload, { applicationNumber, ip });
    const recordId = await fm.createRecord("API_APPLICATIONS", fieldData);
    result.steps.filemaker = { ok: true, recordId };
    if (containerTest) {
      const containers = await runContainerTest(fm, recordId, payload, files, testSignature);
      return json({ ok: containers.uploadsComplete && containers.verificationComplete, captured: true, testMode: "filemaker-containers", applicationNumber, containers }, containers.uploadsComplete && containers.verificationComplete ? 200 : 207);
    }

    // Controlled integration test: create only the FileMaker APPLICATIONS record.
    // The TEST-LEASE marker prevents ordinary applicants from suppressing the downstream pipeline.
    if (filemakerOnly) {
      return json({ ok: true, applicationNumber, message: "FileMaker-only test application received.", testMode: true }, 200);
    }

    // Pull back the true parent UUID. APP_DOCUMENTS::_fk_ApplicationID must not
    // contain the human-facing ApplicationNumber.
    const createdApplication = await fm.getRecord("API_APPLICATIONS", recordId);
    const appPk = createdApplication.__pk_ApplicationID;
    if (!appPk) throw new Error("Created application is missing __pk_ApplicationID");

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

    // 4. APP_DOCUMENTS + DocFile are authoritative and never depend on Box.
    // Box is an optional secondary copy performed only after FileMaker verifies the container.
    if (files.length) {
      result.steps.documents = await createApplicationDocuments({
        fm, box, boxFolderId, applicationId: appPk, applicationNumber,
        adults: payload?.adults || [], files,
      });
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
    if (containerTest || filemakerOnly) {
      console.error("Synthetic FileMaker test failed", { applicationNumber, error: String(e.message || e) });
      return json({ ok: false, code: "FILEMAKER_TEST_FAILED", applicationNumber, recordId: result.steps.filemaker?.recordId || null, partialCapture: Boolean(result.steps.filemaker?.ok) }, 502);
    }
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
  const documentFailure = files.length > 0 && !result.steps.documents?.complete;
  return json(
    captured && !documentFailure
      ? { ok: true, applicationNumber, message: "Application received.", documents: result.steps.documents || { expected: 0, recordsCreated: 0, uploaded: 0, verified: 0, complete: true } }
      : captured
        ? { ok: false, captured: true, code: "DOCUMENTS_FAILED", applicationNumber, message: "The application was saved, but one or more documents could not be stored.", documents: result.steps.documents }
      : { ok: false, code: "CAPTURE_FAILED", message: "We couldn't submit your application. Please try again shortly." },
    captured && !documentFailure ? 200 : 502
  );
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function handleDocumentBackfill(request, env) {
  const supplied = request.headers.get("X-EFH-Backfill-Token") || "";
  if (!supplied || await sha256Hex(supplied) !== BACKFILL_TOKEN_SHA256) {
    return json({ ok: false, code: "UNAUTHORIZED" }, 401);
  }
  const form = await request.formData();
  const applicationNumber = String(form.get("applicationNumber") || "");
  if (!BACKFILL_APPLICATIONS.has(applicationNumber)) return json({ ok: false, code: "APPLICATION_NOT_ALLOWED" }, 400);
  const adults = JSON.parse(String(form.get("adults") || "[]"));
  const files = [];
  for (const [key, value] of form.entries()) {
    if (key.startsWith("doc:") && value instanceof File) {
      const [, adultIndex, docType] = key.split(":");
      files.push({ adultIndex: Number(adultIndex), docType, file: value });
    }
  }
  if (!files.length) return json({ ok: false, code: "FILES_REQUIRED" }, 400);

  const fm = new FileMaker(env);
  try {
    await fm.login();
    const matches = await fm.findRecords("API_APPLICATIONS", [{ ApplicationNumber: `==${applicationNumber}` }], { limit: 2 });
    if (matches.length !== 1 || !matches[0].__pk_ApplicationID) return json({ ok: false, code: "APPLICATION_NOT_FOUND" }, 404);
    const documents = await createApplicationDocuments({
      fm, box: null, boxFolderId: null,
      applicationId: matches[0].__pk_ApplicationID, applicationNumber, adults, files,
    });
    return json({ ok: documents.complete, applicationNumber, documents }, documents.complete ? 200 : 502);
  } finally {
    await fm.logout();
  }
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
      filemakerOnlyTestSupported: true,
      filemakerContainerTestSupported: true,
      containerResultsVersion: 2,
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
  if (url.pathname === "/api/maintenance/backfill-documents" && request.method === "POST") {
    try {
      return await handleDocumentBackfill(request, env);
    } catch (e) {
      return json({ ok: false, code: "BACKFILL_FAILED", message: String(e.message || e) }, 500);
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
