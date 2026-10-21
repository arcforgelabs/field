// Smoke of a built Field image: it answers /health with the commit it was
// built from, serves the client, signs an operator in, and shows the jobs
// board and the catalogue. Data is synthetic: the operator comes from
// run-image-smoke.sh's config and the catalogue from
// scripts/verification/fixtures.js. A page error or console error fails it.
import { expect, test } from "@playwright/test";

const EMAIL = "smoke.operator@example.invalid";
const PASSWORD = "smoke-password-fixture";

function watchErrors(page) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  return errors;
}

test("health names the commit the image was built from", async ({ request }) => {
  const response = await request.get("/health");
  expect(response.ok()).toBe(true);
  const health = await response.json();
  expect(health.ok).toBe(true);
  if (process.env.FIELD_SMOKE_REVISION) expect(health.build?.revision).toBe(process.env.FIELD_SMOKE_REVISION);
});

test("a wrong password is refused and the operator stays signed out", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Email address").fill(EMAIL);
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Invalid email or password")).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});

test("an operator signs in and sees the jobs board and the catalogue", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/");
  await page.getByLabel("Email address").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL(/#\/jobs$/);
  await expect(page.getByRole("heading", { level: 1, name: "Jobs" })).toBeVisible();

  await page.goto("/#/pricing");
  await expect(page.getByRole("heading", { level: 1, name: "Catalogue" })).toBeVisible();
  await expect(page.getByText("Tip-truck haulage (demo)").first()).toBeVisible();

  expect(errors).toEqual([]);
});

test("in a tall, narrow window the settings content starts right under the tabs", async ({ page }) => {
  await page.setViewportSize({ width: 808, height: 1264 });
  await page.goto("/");
  await page.getByLabel("Email address").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/#\/jobs$/);

  await page.goto("/#/settings");
  const tabs = page.getByRole("navigation", { name: "Settings" });
  const heading = page.getByRole("heading", { level: 2, name: "Account and security" });
  await expect(heading).toBeVisible();
  const tabsBox = await tabs.boundingBox();
  const headingBox = await heading.boundingBox();
  // The tab row is one line of buttons, and the first section follows it.
  expect(tabsBox.height).toBeLessThan(80);
  expect(headingBox.y - (tabsBox.y + tabsBox.height)).toBeLessThan(40);
});
