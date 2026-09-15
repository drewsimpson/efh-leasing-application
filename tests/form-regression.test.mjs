import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildFieldData } from "../src/mapping.js";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const worker = await readFile(new URL("../src/index.js", import.meta.url), "utf8");

test("inline application script parses", () => {
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));
});

test("review reads the attributes rendered by applicant fields", () => {
  assert.match(html, /\[data-f="firstName"\]/);
  assert.match(html, /\[data-f="lastName"\]/);
  assert.match(html, /\[data-f="email"\]/);
  assert.doesNotMatch(html, /\[data-name="(?:first|last|email)"\]/);
});

test("selected files survive input reset and are submitted", () => {
  assert.match(html, /d\.__files=input\.multiple\?d\.__files\.concat\(selected\)/);
  assert.match(html, /\(d\.__files\|\|\[\]\)\.forEach/);
  assert.doesNotMatch(html, /forEach\.call\(inp\.files/);
});

test("signature pad resizes when shown and captures pointer input", () => {
  assert.match(html, /if\(c\.__init\)\{if\(c\.__resize\)c\.__resize\(\);return;/);
  assert.match(html, /setPointerCapture/);
  assert.match(html, /pointercancel/);
  assert.match(html, /lostpointercapture/);
  assert.match(html, /\{buildReview\(\);initSig\(\);\}/);
});

test("working FileMaker mapping remains intact", () => {
  const result = buildFieldData({
    application: { propertyId: "PROP-1", unitId: "UNIT-1", unitLabel: "Unit 101", desiredMoveInDate: "2026-10-15", leaseTerm: "12 months", adultCount: 1 },
    adults: [{ firstName: "Test", lastName: "Applicant", phone: "3055550101", email: "test@example.com", residences: [], employers: [] }],
    consent: { screening: true, contactAuth: true, feeAck: true },
    signature: { name: "Test Applicant", json: "" },
  }, { applicationNumber: "TEST-LEASE-001", ip: "192.0.2.1" });
  assert.equal(result.ApplicationNumber, "TEST-LEASE-001");
  assert.equal(result.Phone, "3055550101");
  assert.equal(result.Email, "test@example.com");
  assert.equal(result.DesiredMoveInDate, "10/15/2026");
  assert.equal(result.TermsAndConditionsAccepted, 1);
});

test("FileMaker-only mode is limited to explicit synthetic test records", () => {
  assert.match(worker, /payload\?\.testMode === "filemaker-only"/);
  assert.match(worker, /startsWith\("TEST-LEASE-"\)/);
  const gate = worker.indexOf("if (filemakerOnly)");
  assert.ok(gate > worker.indexOf('fm.createRecord("API_APPLICATIONS"'));
  assert.ok(gate < worker.indexOf("box.auth()"));
  assert.ok(gate < worker.indexOf('fm.runScript("API_APPLICATIONS", "APP_EmailApplicant"'));
});
