const form = document.getElementById("leasingForm");
const pages = [...document.querySelectorAll(".form-page")];
const backButton = document.getElementById("backButton");
const nextButton = document.getElementById("nextButton");
const pageTitle = document.getElementById("pageTitle");
const progressWrap = document.getElementById("progressWrap");
const progressBar = document.getElementById("progressBar");
const stepLabel = document.getElementById("stepLabel");
const stepName = document.getElementById("stepName");
const saveState = document.getElementById("saveState");

const STORAGE_KEY = "efh-leasing-draft-v1";
const NON_PERSISTED_FIELDS = new Set([
  "DateOfBirth",
  "SSN_Last4",
  "DriversLicenseNumber",
]);

const pageMeta = {
  1: { title: "Welcome to Greenways Condominiums", name: "Property Information" },
  2: { title: "Applicant Information", name: "Applicant Information" },
  3: { title: "Leasing Application", name: "Remaining Pages Pending Inventory" },
};

let currentPage = 1;

function safeDraftData() {
  const data = {};
  for (const element of form.elements) {
    if (!element.name || NON_PERSISTED_FIELDS.has(element.name)) continue;
    if (element.type === "button" || element.type === "submit" || element.type === "file") continue;
    if (element.type === "checkbox") data[element.name] = element.checked;
    else data[element.name] = element.value;
  }
  return data;
}

function saveDraft() {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(safeDraftData()));
    saveState.textContent = "Draft saved in this browser session";
  } catch {
    saveState.textContent = "Draft not saved";
  }
}

function restoreDraft() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    for (const [name, value] of Object.entries(data)) {
      const element = form.elements.namedItem(name);
      if (!element) continue;
      if (element.type === "checkbox") element.checked = Boolean(value);
      else element.value = value;
    }
  } catch {
    sessionStorage.removeItem(STORAGE_KEY);
  }
}

function notifyParent() {
  if (window.parent === window) return;
  window.parent.postMessage(
    {
      type: "efh-leasing-resize",
      height: document.documentElement.scrollHeight,
      page: currentPage,
    },
    "*"
  );
}

function renderPage(page) {
  currentPage = page;
  pages.forEach((section) => {
    section.classList.toggle("active", Number(section.dataset.page) === page);
  });

  const meta = pageMeta[page] || pageMeta[3];
  pageTitle.textContent = meta.title;
  progressWrap.hidden = page === 1;
  stepLabel.textContent = `Page ${page} of 8`;
  stepName.textContent = meta.name;
  progressBar.style.width = `${Math.min(100, (page / 8) * 100)}%`;

  backButton.hidden = page === 1;
  nextButton.textContent = page >= 3 ? "Continue after inventory" : "Next";
  nextButton.disabled = page >= 3;

  saveDraft();
  window.scrollTo({ top: 0, behavior: "smooth" });
  setTimeout(notifyParent, 60);
}

form.addEventListener("input", () => {
  saveDraft();
  notifyParent();
});

form.addEventListener("change", () => {
  saveDraft();
  notifyParent();
});

nextButton.addEventListener("click", () => {
  if (currentPage < 3) renderPage(currentPage + 1);
});

backButton.addEventListener("click", () => {
  if (currentPage > 1) renderPage(currentPage - 1);
});

window.addEventListener("load", notifyParent);
window.addEventListener("resize", notifyParent);

restoreDraft();
renderPage(1);
