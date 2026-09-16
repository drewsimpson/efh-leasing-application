// Synthetic-only direct FileMaker container test. Normal intake is unchanged.
export function validateContainerTest(payload, files) {
  if (!String(payload?.adults?.[0]?.otherNames || "").startsWith("TEST-LEASE-")) throw new Error("Synthetic marker required");
  const image = payload?.signature?.imageBase64 || "";
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(image) || image.length > 3000000) throw new Error("Signature PNG required");
  const bytes = Uint8Array.from(atob(image.split(",")[1]), c => c.charCodeAt(0));
  if (bytes.length < 8 || ![137,80,78,71,13,10,26,10].every((n,i) => bytes[i] === n)) throw new Error("Invalid signature PNG");
  const allowed = ["DL_Front", "DL_Back", "Bank_Statement", "Paystub", "Credit_Report"];
  if (!files.length || files.length > 20) throw new Error("Supporting files required");
  for (const f of files) {
    if (![0,1].includes(f.adultIndex) || !allowed.includes(f.docType) || !f.file.size || f.file.size > 20000000 || !["image/png","image/jpeg","application/pdf"].includes(f.file.type)) throw new Error("Invalid supporting file");
  }
  return new File([bytes], "signature_TEST.png", { type: "image/png" });
}

async function verifiedUpload(fm, layout, recordId, field, file) {
  const result = { fileName: file.name, bytes: file.size, uploaded: false, verified: false };
  try { await fm.uploadContainer(layout, recordId, field, file); result.uploaded = true; }
  catch (e) { return { ...result, uploadError: String(e.message || e) }; }
  try {
  const stored = await fm.getRecord(layout, recordId);
  const url = stored[field];
  if (!url || new URL(url).origin !== new URL(fm.base).origin) throw new Error("Missing or unexpected container URL");
  const downloaded = await fm.getContainer(url);
  const original = new Uint8Array(await file.arrayBuffer());
  if (downloaded.length !== original.length || !downloaded.every((b,i) => b === original[i])) throw new Error("Container byte verification failed");
  return { ...result, verified: true };
  } catch (e) { return { ...result, verificationError: String(e.message || e) }; }
}

export async function runContainerTest(fm, recordId, payload, files, signature) {
  const app = await fm.getRecord("API_APPLICATIONS", recordId);
  const applicationId = app.__pk_ApplicationID;
  if (!applicationId) throw new Error("Missing __pk_ApplicationID");
  const result = { applicationId, recordId, signature: await verifiedUpload(fm, "API_APPLICATIONS", recordId, "SignatureTenant", signature), documents: [] };
  for (const f of files) {
    const a = payload.adults[f.adultIndex];
    const item = { recordId: null, adultIndex: f.adultIndex + 1, docType: f.docType, fileName: f.file.name, bytes: f.file.size, uploaded: false, verified: false };
    try {
    const docRecordId = await fm.createRecord("API_APP_DOCUMENTS", {
      _fk_ApplicationID: applicationId,
      AdultIndex: f.adultIndex + 1,
      AdultName: [a.firstName, a.lastName].filter(Boolean).join(" "),
      DocType: f.docType, FileName: f.file.name,
      FileSizeBytes: f.file.size, MimeType: f.file.type,
    });
    result.documents.push({ recordId: docRecordId, adultIndex: f.adultIndex + 1, docType: f.docType, ...await verifiedUpload(fm, "API_APP_DOCUMENTS", docRecordId, "DocFile", f.file) });
    } catch (e) { result.documents.push({ ...item, recordError: String(e.message || e) }); }
  }
  const items = [result.signature, ...result.documents];
  result.uploadsComplete = items.every(i => i.uploaded);
  result.verificationComplete = items.every(i => i.verified);
  return result;
}
