import test from "node:test";
import assert from "node:assert/strict";
import { FileMaker } from "../src/services.js";
import { validateContainerTest, runContainerTest } from "../src/container-test.js";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC1kAAAAASUVORK5CYII=";
const payload = { adults: [{ firstName: "Test", lastName: "Primary", otherNames: "TEST-LEASE-CONTAINERS" }, { firstName: "Test", lastName: "Co" }], signature: { imageBase64: png } };
const files = [{ adultIndex: 1, docType: "Paystub", file: new File(["%PDF-test"], "paystub_TEST.pdf", { type: "application/pdf" }) }];

test("streaming download retries with server cookie and rejects foreign origins", async () => {
  const original = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, headers: { ...options.headers } });
    return calls.length === 1 ? new Response("", { status: 401, headers: { "set-cookie": "stream=secret; Path=/; Secure" } }) : new Response(new Uint8Array([1,2,3]));
  };
  try {
    const fm = new FileMaker({ FM_HOST: "fms.example.test", FM_DATABASE: "Test" }); fm.token = "token";
    assert.deepEqual(await fm.getContainer("https://fms.example.test/Streaming_SSL/test"), new Uint8Array([1,2,3]));
    assert.equal(calls[1].headers.Cookie, "stream=secret");
    assert.equal(calls[1].headers.Authorization, "Bearer token");
    await assert.rejects(() => fm.getContainer("https://foreign.test/file"), /origin/);
    assert.equal(calls.length, 2);
  } finally { globalThis.fetch = original; }
});

test("document creation failure does not stop later document uploads", async () => {
  let created = 0;
  const fm = {
    base: "https://fms.example.test",
    getRecord: async () => ({ __pk_ApplicationID: "uuid", SignatureTenant: "https://fms.example.test/sig", DocFile: "https://fms.example.test/doc" }),
    uploadContainer: async () => {},
    getContainer: async () => { throw new Error("fetch 401"); },
    createRecord: async () => { if (++created === 1) throw new Error("invalid metadata"); return "doc-2"; },
  };
  const r = await runContainerTest(fm, "app", payload, [...files, ...files], validateContainerTest(payload, files));
  assert.equal(r.signature.uploaded, true);
  assert.equal(r.signature.verified, false);
  assert.equal(r.documents.length, 2);
  assert.match(r.documents[0].recordError, /metadata/);
  assert.equal(r.documents[1].recordId, "doc-2");
  assert.equal(r.documents[1].uploaded, true);
  assert.equal(r.uploadsComplete, false);
});

test("container validation rejects missing signatures, empty files and unsupported applicants", () => {
  assert.equal(validateContainerTest(payload, files).type, "image/png");
  assert.throws(() => validateContainerTest({ ...payload, signature: {} }, files));
  assert.throws(() => validateContainerTest(payload, [{ ...files[0], adultIndex: 2 }]));
  assert.throws(() => validateContainerTest(payload, [{ ...files[0], file: new File([], "empty.pdf", { type: "application/pdf" }) }]));
});

test("direct containers link by application UUID and verify actual bytes", async () => {
  const stored = new Map(); const created = [];
  const fm = {
    base: "https://fms.example.test/fmi/data/vLatest/databases/Test",
    getRecord: async (layout,id) => layout === "API_APPLICATIONS" ? { __pk_ApplicationID: "uuid-application", SignatureTenant: "https://fms.example.test/signature" } : { DocFile: "https://fms.example.test/doc" },
    uploadContainer: async (layout,id,field,file) => stored.set(field === "SignatureTenant" ? "https://fms.example.test/signature" : "https://fms.example.test/doc", new Uint8Array(await file.arrayBuffer())),
    getContainer: async url => stored.get(url),
    createRecord: async (layout,data) => { created.push({layout,data}); return "doc-1"; },
  };
  const r = await runContainerTest(fm, "app-record", payload, files, validateContainerTest(payload, files));
  assert.equal(created[0].data._fk_ApplicationID, "uuid-application");
  assert.equal(created[0].data.AdultIndex, 2);
  assert.equal(created[0].data.AdultName, "Test Co");
  assert.equal(r.signature.verified, true);
  assert.equal(r.documents[0].bytes, 9);
  fm.getContainer = async () => new Uint8Array([1]);
  const partial = await runContainerTest(fm, "app-record", payload, files, validateContainerTest(payload, files));
  assert.equal(partial.uploadsComplete, true);
  assert.equal(partial.verificationComplete, false);
  assert.match(partial.signature.verificationError, /verification/);
  assert.equal(partial.documents.length, 1);
});

test("FileMaker uploads use upload part and automatic multipart boundary", async () => {
  const original = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url,options) => { captured={url,options}; return Response.json({ messages: [{code:"0"}], response:{} }); };
  try {
    const fm = new FileMaker({FM_HOST:"fms.example.test",FM_DATABASE:"Test"}); fm.token="test-token";
    await fm.uploadContainer("API_APP_DOCUMENTS","42","DocFile",files[0].file);
    assert.match(captured.url, /records\/42\/containers\/DocFile\/1$/);
    assert.equal(captured.options.headers.Authorization, "Bearer test-token");
    assert.equal(captured.options.headers["Content-Type"], undefined);
    assert.equal(captured.options.body.get("upload").name, "paystub_TEST.pdf");
  } finally { globalThis.fetch=original; }
});
