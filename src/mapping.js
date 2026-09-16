// mapping.js — flatten the form's structured JSON into flat FileMaker field names
// mirroring TenantTrack_RentalApp_Schema_BuildSpec_v2 (tiered model).
//
// Incoming payload shape (from the web form):
// {
//   application: { propertyId, unitId, desiredMoveInDate, leaseTerm, quotedRent, adultCount, numberOfOccupants, howHeard, pets, vehiclesCount },
//   adults: [ {                       // index 0 = primary, 1 = co-applicant 1, 2 = adult3, 3 = adult4
//     firstName, middleName, lastName, otherNames, dob, ssnLast4, dlNumber, dlState, phone, secondaryPhone, email, relationship,
//     residences: [ { current:bool, address, city, state, zip, fromDate, toDate, rentAmount, landlordName, landlordPhone, landlordEmail, utilityInName, reasonForLeaving, rentPaidInFull, gaveNotice, askedToMove } ],
//     employers:  [ { current:bool, employmentStatus, employer, title, address, supervisor, phone, monthlyGross, fromDate, toDate } ],
//     emergencyContact: { name, phone, relationship } // primary applicant only
//   } ],
//   background: { evicted, evictedExplain, brokeLease, brokeLeaseExplain, bankruptcy, bankruptcyExplain, felony, felonyExplain, lawsuit, lawsuitExplain, smoker },
//   consent: { screening, contactAuth, feeAck },
//   signature: { name, dateISO, imageBase64, json },
//   copyEmail
// }

const yn = (v) => (v ? 1 : 0);
const d = (iso) => {
  if (!iso) return "";
  // FileMaker Data API date format for this account: MM/dd/yyyy
  const [y, m, day] = String(iso).split("-");
  return y && m && day ? `${m}/${day}/${y}` : iso;
};

function residence(fd, prefix, res) {
  if (!res) return;
  fd[`${prefix}Address`] = res.address || "";
  fd[`${prefix}City`] = res.city || "";
  fd[`${prefix}State`] = res.state || "";
  fd[`${prefix}Zip`] = res.zip || "";
  fd[`${prefix}ResidencyFrom`] = d(res.fromDate);
  fd[`${prefix}ResidencyTo`] = d(res.toDate);
  fd[`${prefix}RentAmount`] = res.rentAmount || "";
  fd[`${prefix}LandlordName`] = res.landlordName || "";
  fd[`${prefix}LandlordPhone`] = res.landlordPhone || "";
  fd[`${prefix}LandlordEmail`] = res.landlordEmail || "";
  fd[`${prefix}UtilityInName`] = res.utilityInName || "";
  fd[`${prefix}ReasonForLeaving`] = res.reasonForLeaving || "";
  fd[`${prefix}RentPaidInFull`] = yn(res.rentPaidInFull);
  fd[`${prefix}GaveNotice`] = yn(res.gaveNotice);
  fd[`${prefix}AskedToMove`] = yn(res.askedToMove);
}
function employer(fd, prefix, e) {
  if (!e) return;
  fd[`${prefix}Employer`] = e.employer || "";
  fd[`${prefix}Title`] = e.title || "";
  fd[`${prefix}Address`] = e.address || "";
  fd[`${prefix}Supervisor`] = e.supervisor || "";
  fd[`${prefix}Phone`] = e.phone || "";
  fd[`${prefix}MonthlyGross`] = e.monthlyGross || "";
  fd[`${prefix}From`] = d(e.fromDate);
  fd[`${prefix}To`] = d(e.toDate);
}

// Primary applicant (adults[0]) uses the existing field names.
function mapPrimary(fd, a) {
  fd.FirstName = a.firstName || "";
  fd.MiddleName = a.middleName || "";
  fd.LastName = a.lastName || "";
  fd.OtherNamesUsed = a.otherNames || "";
  fd.DateOfBirth = d(a.dob);
  fd.SSN_Last4 = a.ssnLast4 || "";
  fd.DriversLicenseNumber = a.dlNumber || "";
  fd.DriversLicenseState = a.dlState || "";
  fd.Phone = a.phone || "";
  fd.SecondaryPhone = a.secondaryPhone || "";
  fd.Email = a.email || "";
  // FullName is a calculation field in FileMaker — do not write it (auto-computes from First/Last).

  const R = a.residences || [];
  // current
  const cur = R.find((r) => r.current) || R[0];
  if (cur) {
    fd.CurrentAddress = cur.address || "";
    fd.CurrentCity = cur.city || "";
    fd.CurrentState = cur.state || "";
    fd.CurrentZip = cur.zip || "";
    fd.CurrentLandLord = cur.landlordName || "";
    fd.CurrentLandlordPhone = cur.landlordPhone || "";
    fd.CurrentLandlordEmail = cur.landlordEmail || "";
    fd.CurrentRentAmount = cur.rentAmount || "";
    fd.CurrentResidencyFrom = d(cur.fromDate);
    fd.CurrentResidencyTo = d(cur.toDate);
    fd.CurrentReasonForLeaving = cur.reasonForLeaving || "";
    fd.CurrentUtilityInName = cur.utilityInName || "";
    fd.CurrentRentPaidInFull = yn(cur.rentPaidInFull);
    fd.CurrentGaveNotice = yn(cur.gaveNotice);
    fd.CurrentAskedToMove = yn(cur.askedToMove);
  }
  const prev = R.filter((r) => !r.current);
  if (prev[0]) {
    const p = prev[0];
    fd.PreviousAddressLine1 = p.address || "";
    fd.PreviousCity = p.city || "";
    fd.PreviousState = p.state || "";
    fd.PreviousZip = p.zip || "";
    fd.PreviousLandlordName = p.landlordName || "";
    fd.LandlordPhoneNumber = p.landlordPhone || "";
    fd.LandlordEmail = p.landlordEmail || "";
    fd.PreviousMonthlyRent = p.rentAmount || "";
    fd.PreviousResidencyFrom = d(p.fromDate);
    fd.PreviousResidencyTo = d(p.toDate);
    fd.PreviousReasonForLeaving = p.reasonForLeaving || "";
    fd.PreviousUtilityInName = p.utilityInName || "";
    fd.PreviousRentPaidInFull = yn(p.rentPaidInFull);
    fd.PreviousGaveNotice = yn(p.gaveNotice);
    fd.PreviousAskedToMove = yn(p.askedToMove);
  }
  if (prev[1]) residence(fd, "Previous2", prev[1]);
  if (prev[2]) residence(fd, "Previous3", prev[2]);

  const E = a.employers || [];
  const curE = E.find((e) => e.current) || E[0];
  if (curE) {
    fd.EmployerName = curE.employer || "";
    fd.EmploymentStatus = curE.employmentStatus || "";
    fd.JobTitle = curE.title || "";
    fd.EmployerAddress = curE.address || "";
    fd.EmployerPhone = curE.phone || "";
    fd.EmployerSupervisor = curE.supervisor || "";
    fd.GrossMonthlyIncome = curE.monthlyGross || "";
    fd.EmploymentFrom = d(curE.fromDate);
    fd.EmploymentTo = d(curE.toDate);
  }
  const prevE = E.filter((e) => !e.current);
  ["PrevEmployer1", "PrevEmployer2", "PrevEmployer3"].forEach((pfx, i) => {
    if (prevE[i]) employer(fd, pfx, prevE[i]);
  });

  const emergency = a.emergencyContact || {};
  fd.EmergencyContactName = emergency.name || "";
  fd.EmergencyContactPhone = emergency.phone || "";
  fd.EmergencyContactRelationship = emergency.relationship || "";
}

// Co-applicant 1 (adults[1]) — full history under CoApplicant* prefix.
function mapCoApplicant(fd, a) {
  fd.CoApplicantFirstName = a.firstName || "";
  fd.CoApplicantMiddleName = a.middleName || "";
  fd.CoApplicantLastName = a.lastName || "";
  fd.CoApplicantOtherNamesUsed = a.otherNames || "";
  fd.CoApplicantDateOfBirth = d(a.dob);
  fd.CoApplicantSSN_Last4 = a.ssnLast4 || "";
  fd.CoApplicantDriversLicenseNumber = a.dlNumber || "";
  fd.CoApplicantDriversLicenseState = a.dlState || "";
  fd.CoApplicantPhone = a.phone || "";
  fd.CoApplicantSecondaryPhone = a.secondaryPhone || "";
  fd.CoApplicantEmail = a.email || "";

  const R = a.residences || [];
  const cur = R.find((r) => r.current) || R[0];
  residence(fd, "CoApplicantCurrent", cur);
  const prev = R.filter((r) => !r.current);
  ["CoApplicantPrevious1", "CoApplicantPrevious2", "CoApplicantPrevious3"].forEach((pfx, i) => {
    if (prev[i]) residence(fd, pfx, prev[i]);
  });

  const E = a.employers || [];
  const curE = E.find((e) => e.current) || E[0];
  employer(fd, "CoApplicantEmployer", curE);
  if (curE) fd.CoApplicantEmploymentStatus = curE.employmentStatus || "";
  const prevE = E.filter((e) => !e.current);
  ["CoApplicantPrevEmployer1", "CoApplicantPrevEmployer2", "CoApplicantPrevEmployer3"].forEach((pfx, i) => {
    if (prevE[i]) employer(fd, pfx, prevE[i]);
  });
}

// Adults 3 & 4 — identity + current residence + current employer only.
function mapMinimalAdult(fd, a, n) {
  const P = `Adult${n}_`;
  fd[`${P}FirstName`] = a.firstName || "";
  fd[`${P}MiddleName`] = a.middleName || "";
  fd[`${P}LastName`] = a.lastName || "";
  fd[`${P}OtherNamesUsed`] = a.otherNames || "";
  fd[`${P}DateOfBirth`] = d(a.dob);
  fd[`${P}SSN_Last4`] = a.ssnLast4 || "";
  fd[`${P}DriversLicenseNumber`] = a.dlNumber || "";
  fd[`${P}DriversLicenseState`] = a.dlState || "";
  fd[`${P}Phone`] = a.phone || "";
  fd[`${P}Email`] = a.email || "";
  fd[`${P}Relationship`] = a.relationship || "";
  const R = a.residences || [];
  const cur = R.find((r) => r.current) || R[0];
  if (cur) {
    fd[`${P}CurrentAddress`] = cur.address || "";
    fd[`${P}CurrentCity`] = cur.city || "";
    fd[`${P}CurrentState`] = cur.state || "";
    fd[`${P}CurrentZip`] = cur.zip || "";
    fd[`${P}CurrentLandlordName`] = cur.landlordName || "";
    fd[`${P}CurrentLandlordPhone`] = cur.landlordPhone || "";
  }
  const E = a.employers || [];
  const curE = E.find((e) => e.current) || E[0];
  if (curE) {
    fd[`${P}EmployerName`] = curE.employer || "";
    fd[`${P}JobTitle`] = curE.title || "";
    fd[`${P}EmployerPhone`] = curE.phone || "";
    fd[`${P}MonthlyGross`] = curE.monthlyGross || "";
  }
}

export function buildFieldData(payload, ctx) {
  const app = payload.application || {};
  const adults = payload.adults || [];
  const fd = {
    ApplicationNumber: ctx.applicationNumber,
    Source: "Web (Cloudflare)",
    ApplicationStatus: "Pending Review", // must be a value in vl_ApplicationStatus (intake stage)
    ConsentIPAddress: ctx.ip || "",
    AdultCount: app.adultCount || adults.length || 1,
    NumberOfOccupants: app.numberOfOccupants || app.adultCount || adults.length || 1,
    _fk_PropertyID: app.propertyId || "",
    _fk_UnitID: app.unitId || "",
    DesiredUnit: app.unitLabel || "",
    DesiredMoveInDate: d(app.desiredMoveInDate),
    LeaseTerm: app.leaseTerm || "",
    RentAmount: app.quotedRent || "",
    // 'Pets' is value-list validated (send an allowed value once known); free text goes to PetDetails.
    PetDetails: app.pets || app.petDetails || "",
  };

  if (adults[0]) mapPrimary(fd, adults[0]);
  if (adults[1]) mapCoApplicant(fd, adults[1]);
  if (adults[2]) mapMinimalAdult(fd, adults[2], 3);
  if (adults[3]) mapMinimalAdult(fd, adults[3], 4);

  const bg = payload.background || {};
  fd.Bg_Evicted = yn(bg.evicted); fd.Bg_Evicted_Explain = bg.evictedExplain || "";
  fd.Bg_BrokeLease = yn(bg.brokeLease); fd.Bg_BrokeLease_Explain = bg.brokeLeaseExplain || "";
  fd.Bg_Bankruptcy = yn(bg.bankruptcy); fd.Bg_Bankruptcy_Explain = bg.bankruptcyExplain || "";
  fd.Bg_Felony = yn(bg.felony); fd.Bg_Felony_Explain = bg.felonyExplain || "";
  fd.Bg_Lawsuit = yn(bg.lawsuit); fd.Bg_Lawsuit_Explain = bg.lawsuitExplain || "";
  fd.Bg_Smoker = yn(bg.smoker);

  const c = payload.consent || {};
  // BackgroundCheckConsent is value-list validated — set an allowed value once known (screening consent
  // is also captured below via Consent_* + TermsAndConditionsAccepted).
  fd.Consent_ContactAuth = yn(c.contactAuth);
  fd.Consent_FeeAck = yn(c.feeAck);
  fd.TermsAndConditionsAccepted = yn(c.screening && c.contactAuth && c.feeAck);

  const s = payload.signature || {};
  fd.ElectronicSignatureText = s.name || "";
  fd.Signature_json = s.json || "";
  fd.CopyEmail = payload.copyEmail || (adults[0] && adults[0].email) || "";

  // strip empty strings to keep payload lean (optional)
  Object.keys(fd).forEach((k) => { if (fd[k] === "") delete fd[k]; });
  return fd;
}
