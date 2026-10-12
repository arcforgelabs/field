// The installation's configured business profile (config businessProfile),
// merged over the quote catalogue's wherever a profile is read.
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import {
  applyBusinessProfileOverride,
  configuredTradingName,
  normalizeBusinessProfileConfig,
} from "./business-profile.js";
import { configureBusinessProfile, getQuoteCatalog, getQuoteCatalogsForAuthoritySnapshot, serializeQuoteCatalog } from "./quote-catalogs.js";
import { generateQuotePdfBuffer, resolveDocumentBusiness } from "./quote-artifacts.js";
import { buildDocumentEmailText } from "./send-quote-email.js";
import { renderEmailTemplate, DEFAULT_EMAIL_TEMPLATES } from "../shared/email-templates.js";

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
  assert.equal(configuredTradingName(), null);
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
  assert.equal(before.tradingName, "Your Business");
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

  const template = DEFAULT_EMAIL_TEMPLATES.quote[0];
  assert.match(renderEmailTemplate(template, { clientName: "Pat", businessName: "Acme <Landscapes>" }).html, /Regards,<br\/>Acme &lt;Landscapes&gt;<\/p>/);
  assert.match(renderEmailTemplate(template, { clientName: "Pat" }).html, /Regards,<br\/>Your Business<\/p>/);
});
