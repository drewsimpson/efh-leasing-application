import { verifiedUpload } from "./container-test.js";

export const DOCUMENT_TYPES = ["DL_Front", "DL_Back", "Bank_Statement", "Paystub", "Credit_Report"];

export async function createApplicationDocuments({ fm, box, boxFolderId, applicationId, applicationNumber, adults, files }) {
  if (!applicationId) throw new Error("Missing parent __pk_ApplicationID");
  const results = [];
  let sortOrder = 0;

  for (const item of files) {
    if (!DOCUMENT_TYPES.includes(item.docType) || ![0, 1].includes(item.adultIndex)) continue;
    sortOrder += 1;
    const adult = adults[item.adultIndex] || {};
    const adultName = [adult.firstName, adult.lastName].filter(Boolean).join(" ");
    const result = {
      recordId: null,
      adultIndex: item.adultIndex + 1,
      adultName,
      docType: item.docType,
      fileName: item.file.name,
      bytes: item.file.size,
      uploaded: false,
      verified: false,
      boxUploaded: false,
    };

    try {
      const recordId = await fm.createRecord("API_APP_DOCUMENTS", {
        _fk_ApplicationID: applicationId,
        ApplicationNumber: applicationNumber,
        AdultIndex: item.adultIndex + 1,
        AdultName: adultName,
        ApplicantRole: item.adultIndex === 0 ? "Primary Applicant" : "Co-Applicant",
        DocType: item.docType,
        DocFileName: item.file.name,
        FileName: item.file.name,
        FileSize: item.file.size,
        FileSizeBytes: item.file.size,
        MimeType: item.file.type || "application/octet-stream",
        IsCurrent: 1,
        ReviewStatus: "Pending Review",
        SortOrder: sortOrder,
        UploadSource: "Cloudflare Worker",
      });
      result.recordId = recordId;
      Object.assign(result, await verifiedUpload(fm, "API_APP_DOCUMENTS", recordId, "DocFile", item.file));

      if (result.verified && box && boxFolderId) {
        try {
          const bytes = new Uint8Array(await item.file.arrayBuffer());
          const safeName = `${item.docType}_A${item.adultIndex + 1}_${item.file.name}`.replace(/[^\w.\- ]/g, "_");
          const uploaded = await box.uploadFile(safeName, bytes, boxFolderId, item.file.type || "application/octet-stream");
          await fm.updateRecord("API_APP_DOCUMENTS", recordId, { BoxFileID: uploaded.id, BoxFileURL: uploaded.url });
          result.boxUploaded = true;
          result.boxFileId = uploaded.id;
        } catch (error) {
          result.boxError = String(error.message || error);
        }
      }
    } catch (error) {
      result.error = String(error.message || error);
    }
    results.push(result);
  }

  return {
    expected: results.length,
    recordsCreated: results.filter((item) => item.recordId).length,
    uploaded: results.filter((item) => item.uploaded).length,
    verified: results.filter((item) => item.verified).length,
    complete: results.length > 0 && results.every((item) => item.recordId && item.uploaded && item.verified),
    results,
  };
}
