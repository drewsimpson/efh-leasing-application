import test from "node:test";
import assert from "node:assert/strict";
import { FileMaker } from "../src/services.js";
import { validateContainerTest, runContainerTest } from "../src/container-test.js";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC1kAAAAASUVORK5CYII=";
const payload = { adults: [{ firstName: "Test", lastName: "Primary", otherNames: "TEST-LEASE-CONTAINERS" }, { firstName: "Test", lastName: "Co" }], signature: { imageBase64: png } };
const files = [{ adultIndex: 1, docType: "Paystub", file: new File(["%PDF-test"], "paystub_TEST.pdf", { type: "application/pdf" }) }];

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
  await assert.rejects(() => runContainerTest(fm, "app-record", payload, files, validateContainerTest(payload, files)), /verification/);
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
