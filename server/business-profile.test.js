// The installation's configured business profile (config businessProfile),
// merged over the quote catalogue's wherever a profile is read.
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import {
  applyBusinessProfileOverride,
  businessDisplayName,
  DEFAULT_BUSINESS_NAME,
  installationBusinessName,
  normalizeBusinessProfileConfig,
} from "./business-profile.js";
import { configureBusinessProfile, getQuoteCatalog, getQuoteCatalogsForAuthoritySnapshot, serializeQuoteCatalog } from "./quote-catalogs.js";
import { generateQuotePdfBuffer, resolveDocumentBusiness } from "./quote-artifacts.js";
import { partiesDetails } from "./documents/job-sources.js";
import { buildDocumentEmailText } from "./send-quote-email.js";
import { renderEmailTemplate, renderSignature, DEFAULT_EMAIL_TEMPLATES } from "../shared/email-templates.js";

// Placeholder values only: never a real business's details.
const CONFIGURED = {
  tradingName: "Acme Landscapes",
  legalName: "Acme Landscapes Pty Ltd",
  abn: "11 222 333 444",
  address: "1 Example Road, Sampletown SA 5000",
  phone: "08 0000 0000",
  email: "accounts@acme.example",
  paymentMethods: { bankTransfer: { accountName: "Acme Landscapes Pty Ltd", bsb: "111-222", accountNumber: "12345678", bank: "Example Bank" } },
};

afterEach(() => configureBusinessProfile(null));

test("unset or empty config changes nothing", () => {
  assert.equal(normalizeBusinessProfileConfig(undefined), null);
  assert.equal(normalizeBusinessProfileConfig({}), null);
  assert.equal(normalizeBusinessProfileConfig({ paymentMethods: { bankTransfer: {} } }), null);
  configureBusinessProfile(undefined);
  const profile = { tradingName: "Catalogue Name" };
  assert.equal(applyBusinessProfileOverride(profile), profile, "the same object, untouched");
  assert.equal(installationBusinessName(), DEFAULT_BUSINESS_NAME);
});

test("a bad businessProfile stops boot with a message naming the field, never the value", () => {
  assert.throws(() => normalizeBusinessProfileConfig("Acme"), /businessProfile must be an object/);
  assert.throws(() => normalizeBusinessProfileConfig({ tradingname: "x" }), /unknown field "tradingname"/);
  assert.throws(() => normalizeBusinessProfileConfig({ abn: 11222333444 }), /businessProfile\.abn must be a string/);
  assert.throws(() => normalizeBusinessProfileConfig({ paymentMethods: { paypal: {} } }), /unknown field "paypal"/);
  assert.throws(
    () => normalizeBusinessProfileConfig({ paymentMethods: { bankTransfer: { bsb: 111222 } } }),
    (error) => /bankTransfer\.bsb must be a string/.test(error.message) && !error.message.includes("111222"),
  );
});

test("configured fields win; fields left out keep the catalogue's; an empty string clears", () => {
  configureBusinessProfile({ tradingName: "Acme Landscapes", abn: "", paymentMethods: { bankTransfer: { bsb: "111-222" } } });
  const merged = applyBusinessProfileOverride({
    tradingName: "Catalogue Name",
    legalName: "Catalogue Pty Ltd",
    abn: "99 999 999 999",
    paymentMethods: { bankTransfer: { accountName: "Catalogue Pty Ltd", bsb: "000-000", accountNumber: "00000000", bank: "Old" }, other: { note: "kept" } },
  });
  assert.equal(merged.tradingName, "Acme Landscapes");
  assert.equal(merged.legalName, "Catalogue Pty Ltd");
  assert.equal(merged.abn, "");
  assert.deepEqual(merged.paymentMethods.bankTransfer, { accountName: "Catalogue Pty Ltd", bsb: "111-222", accountNumber: "00000000", bank: "Old" });
  assert.deepEqual(merged.paymentMethods.other, { note: "kept" });
});

test("quote catalogues carry the configured profile, so every new quote snapshot does too", () => {
  const before = serializeQuoteCatalog("embark-default").businessProfile;
  assert.equal(before.tradingName, undefined, "the sample names no trading name");
  assert.equal(before.legalName, "Your Business Pty Ltd");
  configureBusinessProfile(CONFIGURED);
  const catalog = getQuoteCatalog("embark-default");
  assert.deepEqual(catalog.businessProfile, { ...before, ...CONFIGURED });
  assert.equal(catalog.deliveryDefaults.issuerName, "Acme Landscapes", "the configured name is the issuer printed");
  assert.equal(serializeQuoteCatalog("embark-default").businessProfile.abn, "11 222 333 444");
  assert.equal(getQuoteCatalogsForAuthoritySnapshot()["embark-default"].businessProfile.tradingName, "Acme Landscapes");
  configureBusinessProfile(null);
  assert.deepEqual(serializeQuoteCatalog("embark-default").businessProfile, before, "clearing it restores the catalogue's");
});

test("PDFs and issued-document records use the configured profile, bank details included, over an older quote's snapshot", async () => {
  // A quote saved before the profile was configured still names the catalogue's business.
  const quote = {
    kind: "quote",
    version: 1,
    quoteNumber: "EQ-2501-01",
    title: "Profile test",
    quoteCatalog: { id: "embark-default", currency: "AUD", gstRate: 0.1, businessProfile: { tradingName: "Your Business", abn: "" } },
    lineItems: [{ code: "wall", label: "Retaining wall", quantity: 1, unit: "lot", unitPrice: 100, totalPrice: 100, customerVisible: true }],
    presentation: { scopeText: "Wall", scheduleItems: [{ code: "wall", label: "Retaining wall", quantity: 1, unit: "lot", unitPrice: 100, totalPrice: 100, sourceLineItemCodes: ["wall"] }] },
    totals: { subtotal: 100, gst: 10, total: 110, currency: "AUD" },
    delivery: { status: "final" },
  };
  assert.equal(resolveDocumentBusiness(quote).tradingName, "Your Business");
  configureBusinessProfile(CONFIGURED);
  const business = resolveDocumentBusiness(quote);
  assert.equal(business.tradingName, "Acme Landscapes");
  assert.equal(business.abn, "11 222 333 444");
  assert.deepEqual(business.paymentMethods.bankTransfer, CONFIGURED.paymentMethods.bankTransfer);
  const pdf = await generateQuotePdfBuffer({ meta: { id: "job-1", title: "Profile test" }, quote, creationDate: new Date("2026-01-01T00:00:00Z") });
  assert.ok(pdf.includes(Buffer.from("Acme Landscapes")), "the PDF's author is the configured trading name");
});

test("the plain-text email and stock signatures speak for the profile's trading name", () => {
  const quote = { delivery: { status: "final" }, quoteCatalog: { id: "embark-default", businessProfile: { tradingName: "Catalogue Name" } } };
  const meta = { title: "Back yard" };
  const catalogueText = buildDocumentEmailText({ meta, quote, documentType: "quote" });
  assert.match(catalogueText, /Please find the quote from Catalogue Name attached as a PDF\./);
  assert.match(catalogueText, /Regards,\nCatalogue Name/);
  configureBusinessProfile(CONFIGURED);
  const text = buildDocumentEmailText({ meta, quote, documentType: "invoice" });
  assert.match(text, /Please find the invoice from Acme Landscapes attached as a PDF\./);
  assert.match(text, /Regards,\nAcme Landscapes/);
  assert.doesNotMatch(text, /Your Business|Catalogue Name/);

  // Templates end before the sign-off; the signature (the operator's own, or
  // the default) signs with the business name the server supplies.
  const template = DEFAULT_EMAIL_TEMPLATES.quote[0];
  assert.doesNotMatch(renderEmailTemplate(template, { clientName: "Pat", businessName: "Acme <Landscapes>" }).html, /Regards/);
  assert.match(renderSignature(null, { senderName: "Pat Operator", businessName: "Acme <Landscapes>" }), /Regards,<br\/><span data-merge="senderName">Pat Operator<\/span><br\/><span data-merge="businessName">Acme &lt;Landscapes&gt;<\/span><\/p>/);
  assert.doesNotMatch(renderSignature(null, { senderName: "Pat Operator" }), /Your Business|Catalogue Name/, "no invented name");
});

// ── The trading name is optional: the legal name stands in for it ──
const LEGAL_ONLY = {
  legalName: "Acme Landscapes Pty Ltd",
  abn: "11 222 333 444",
  paymentMethods: { bankTransfer: { bsb: "111-222", accountNumber: "12345678", bank: "Example Bank" } },
};

function quoteWithProfile(businessProfile) {
  return {
    kind: "quote",
    version: 1,
    quoteNumber: "EQ-2501-02",
    title: "Legal name test",
    quoteCatalog: { id: "embark-default", currency: "AUD", gstRate: 0.1, businessProfile },
    lineItems: [{ code: "wall", label: "Retaining wall", quantity: 1, unit: "lot", unitPrice: 100, totalPrice: 100, customerVisible: true }],
    presentation: { scopeText: "Wall", scheduleItems: [{ code: "wall", label: "Retaining wall", quantity: 1, unit: "lot", unitPrice: 100, totalPrice: 100, sourceLineItemCodes: ["wall"] }] },
    totals: { subtotal: 100, gst: 10, total: 110, currency: "AUD" },
    delivery: { status: "final" },
  };
}

test("one helper decides the printed name: trading name, else legal name, else a neutral default", () => {
  assert.equal(businessDisplayName({ tradingName: "Acme Landscapes", legalName: "Acme Landscapes Pty Ltd" }), "Acme Landscapes");
  assert.equal(businessDisplayName({ legalName: "Acme Landscapes Pty Ltd" }), "Acme Landscapes Pty Ltd");
  assert.equal(businessDisplayName({ tradingName: "  ", legalName: "Acme Landscapes Pty Ltd" }), "Acme Landscapes Pty Ltd");
  assert.equal(businessDisplayName({}), DEFAULT_BUSINESS_NAME);
  assert.equal(businessDisplayName(null), DEFAULT_BUSINESS_NAME);
  assert.doesNotMatch(DEFAULT_BUSINESS_NAME, /Your Business/);
});

test("with no tradingName configured, the legal name is used everywhere and nothing prints a placeholder name", async () => {
  configureBusinessProfile(LEGAL_ONLY);
  // The catalogue served to quote builds, and so every new quote's snapshot and issuer.
  const catalog = getQuoteCatalog("embark-default");
  assert.equal(catalog.businessProfile.tradingName, undefined);
  assert.equal(businessDisplayName(catalog.businessProfile), "Acme Landscapes Pty Ltd");
  assert.equal(catalog.deliveryDefaults.issuerName, "Acme Landscapes Pty Ltd");
  assert.equal(installationBusinessName(), "Acme Landscapes Pty Ltd");
  // A new quote's PDF: author, header issuer, footer, bank account name.
  const quote = quoteWithProfile(serializeQuoteCatalog("embark-default").businessProfile);
  const business = resolveDocumentBusiness(quote);
  assert.equal(businessDisplayName(business), "Acme Landscapes Pty Ltd");
  assert.equal(business.paymentMethods.bankTransfer.accountName, "", "the account name falls back to the legal name when printed");
  const pdf = await generateQuotePdfBuffer({ meta: { id: "job-2", title: "Legal name test" }, quote, creationDate: new Date("2026-01-01T00:00:00Z") });
  assert.ok(pdf.includes(Buffer.from("Acme Landscapes Pty Ltd")));
  assert.ok(!pdf.includes(Buffer.from("Your Business")), "no placeholder name in the PDF");
  // The issued-document record names the business by its legal name.
  assert.equal(partiesDetails({ meta: { id: "job-2" }, quote }).business.tradingName, "Acme Landscapes Pty Ltd");
  // Email: plain-text body and signature.
  const text = buildDocumentEmailText({ meta: { title: "Back yard" }, quote, documentType: "quote" });
  assert.match(text, /Please find the quote from Acme Landscapes Pty Ltd attached as a PDF\./);
  assert.match(text, /Regards,\nAcme Landscapes Pty Ltd/);
  assert.doesNotMatch(text, /Your Business/);
});

test("a configured tradingName still wins over the legal name", () => {
  configureBusinessProfile({ ...LEGAL_ONLY, tradingName: "Acme Landscapes" });
  const catalog = getQuoteCatalog("embark-default");
  assert.equal(catalog.deliveryDefaults.issuerName, "Acme Landscapes");
  assert.equal(businessDisplayName(resolveDocumentBusiness(quoteWithProfile(catalog.businessProfile))), "Acme Landscapes");
  assert.equal(installationBusinessName(), "Acme Landscapes");
});

test("an empty tradingName clears the catalogue's back to the legal name", () => {
  configureBusinessProfile({ ...LEGAL_ONLY, tradingName: "" });
  // An older quote whose snapshot still carries a trading name.
  const quote = quoteWithProfile({ tradingName: "Catalogue Name", legalName: "Catalogue Pty Ltd" });
  assert.equal(businessDisplayName(resolveDocumentBusiness(quote)), "Acme Landscapes Pty Ltd");
  assert.match(buildDocumentEmailText({ meta: {}, quote, documentType: "invoice" }), /from Acme Landscapes Pty Ltd attached/);
  assert.equal(getQuoteCatalog("embark-default").deliveryDefaults.issuerName, "Acme Landscapes Pty Ltd");
});

test("a profile with neither name falls back to the neutral default, never a placeholder business", () => {
  const quote = quoteWithProfile(null);
  assert.equal(businessDisplayName(resolveDocumentBusiness(quote)), DEFAULT_BUSINESS_NAME);
  assert.match(buildDocumentEmailText({ meta: {}, quote: { delivery: { status: "final" } }, documentType: "quote" }), new RegExp(`from ${DEFAULT_BUSINESS_NAME} attached`));
});
