// Real browser + server + PostgreSQL. run-image-smoke.sh captures Gmail
// offline; no API stubs supply the behavior asserted here.
import { expect, test } from "@playwright/test";

// Send now has a real ten-second Undo hold. Refresh the email history until
// delivery is recorded, rather than treating queue acceptance as delivery.
async function waitForSent(page, count) {
  await expect(async () => {
    await page.reload();
    const history = page.getByRole("list", { name: "Email on this job" });
    await expect(history.getByText("Sent", { exact: true })).toHaveCount(count);
  }).toPass({ timeout: 30_000, intervals: [1000, 2000] });
}

test("an operator prices, sends and invoices a new quote", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const address = "12 Browser Proof Street, Sampleton " + testInfo.project.name;
  await page.goto("/");
  await page.getByLabel("Email address").fill("smoke.operator@example.invalid");
  await page.getByLabel("Password", { exact: true }).fill("smoke-password-fixture");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/#\/jobs$/);

  await page.getByRole("main").locator("header").getByRole("button", { name: /New quote/ }).click();
  const dialog = page.getByRole("dialog", { name: "New quote" });
  await dialog.getByLabel("Site address").fill(address);
  await dialog.getByLabel("Customer", { exact: true }).fill("Browser Proof Customer");
  await dialog.getByLabel("Email", { exact: true }).fill("customer@example.invalid");
  await dialog.getByRole("button", { name: "Create and start quoting" }).click();
  await expect(page.getByRole("heading", { level: 1, name: address })).toBeVisible();
  const jobUrl = page.url().split("?")[0];

  await page.getByPlaceholder("Add an item — type to search the catalogue").fill("Tip-truck haulage");
  await page.getByRole("option", { name: /Tip-truck haulage \(demo\)/ }).click();
  await page.getByRole("textbox", { name: "Quantity", exact: true }).fill("2");
  const rate = page.getByRole("textbox", { name: "Rate", exact: true });
  // Focusing switches the currency display to its editable numeric value.
  await rate.click();
  await rate.fill("150");
  await rate.press("Enter");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  // A reload proves the edited prices reached the real persistence boundary.
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Quantity", exact: true })).toHaveValue("2");
  await expect(rate).toHaveValue("$150.00");
  await expect(page.getByRole("button", { name: "Send quote", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Send quote", exact: true }).click();
  await expect(page).toHaveURL(/email-editor/);
  await page.getByRole("button", { name: "Send", exact: true }).filter({ visible: true }).click();
  await expect(page).toHaveURL(jobUrl + "?tab=email");
  await waitForSent(page, 1);
  await page.goto(jobUrl);
  await expect(page.getByRole("button", { name: "Mark accepted", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Mark accepted", exact: true }).click();
  await page.getByRole("alertdialog", { name: "Mark as accepted?" }).getByRole("button", { name: "Mark accepted", exact: true }).click();

  const sendInvoice = page.getByRole("button", { name: /^Send .* invoice$/ }).first();
  await expect(sendInvoice).toBeEnabled();
  await sendInvoice.click();
  await expect(page).toHaveURL(/email-editor.*documentType=invoice/);
  await page.getByRole("button", { name: "Send", exact: true }).filter({ visible: true }).click();
  await expect(page).toHaveURL(jobUrl + "?tab=email");
  await waitForSent(page, 2);
  await page.goto(jobUrl);
  // A recorded payment is offered only after the invoice is actually issued.
  await expect(page.getByRole("button", { name: "Record payment", exact: true }).first()).toBeVisible();
  await page.getByRole("tab", { name: "Email", exact: true }).click();
  const sent = page.getByRole("list", { name: "Email on this job" });
  await expect(sent.getByRole("listitem")).toHaveCount(2);
  await expect(sent.getByText("Sent", { exact: true })).toHaveCount(2);
  await expect(sent.getByText("customer@example.invalid", { exact: false }).first()).toBeVisible();
});
