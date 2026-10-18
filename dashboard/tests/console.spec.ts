import { test, expect, Page } from "@playwright/test";

const failed = {
  id: "1dc394a0-007e-4370-a249-a6f031aa1234", status: "dead_letter", priority: 9,
  attempts: 3, max_retries: 3, worker_id: null, created_at: "2026-10-18T00:00:00+00:00",
  scheduled_at: null, started_at: null, completed_at: null,
  payload: { type: "compute", iterations: 200000 }, result: null, error: "Task exceeded retry budget",
};

async function mockApi(page: Page) {
  const jobs = [{ ...failed }];
  let submissions = 0;
  await page.route("http://127.0.0.1:8000/**", async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" } });
    } else if (url.pathname === "/workers") {
      await route.fulfill({ headers: { "Access-Control-Allow-Origin": "*" }, json: { "worker-alpha": { status: "alive", last_seen: Date.now(), current_job_id: null } } });
    } else if (url.pathname === "/jobs" && route.request().method() === "POST") {
      submissions++;
      jobs.unshift({ ...failed, id: "2dc394a0-007e-4370-a249-a6f031aa5678", status: "pending", error: "", attempts: 0 });
      await route.fulfill({ headers: { "Access-Control-Allow-Origin": "*" }, status: 201, json: jobs[0] });
    } else if (url.pathname.endsWith("/retry")) {
      await route.fulfill({ headers: { "Access-Control-Allow-Origin": "*" }, status: 409, json: { detail: "Job has already been claimed. Refresh its status." } });
    } else {
      await route.fulfill({ headers: { "Access-Control-Allow-Origin": "*" }, json: jobs });
    }
  });
  await page.routeWebSocket("ws://127.0.0.1:8000/ws/jobs", () => {});
  return { submissions: () => submissions };
}

test("inspect errors, payload, and offset timestamps; Escape restores focus", async ({ page }, testInfo) => {
  await mockApi(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Queue operations" })).toBeVisible();
  const inspect = page.getByRole("button", { name: `Inspect job ${failed.id}` });
  await expect(inspect).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("console-desktop.png"), fullPage: true });
  await inspect.click();
  const dialog = page.getByRole("dialog", { name: "Job details" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(failed.error)).toBeVisible();
  await expect(dialog.getByText("05:30:00", { exact: true })).toBeVisible();
  await expect(dialog.getByText(/200000/)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(inspect).toBeFocused();
  await page.getByRole("textbox", { name: /Search jobs/ }).fill("no-match");
  await expect(page.getByText(/No jobs match/)).toBeVisible();
});

test("dispatch once and surface failed actions", async ({ page }) => {
  const api = await mockApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Re-drive" }).click();
  await expect(page.getByRole("alert")).toContainText("already been claimed");
  await page.getByRole("button", { name: "Enqueue Task" }).click();
  const dialog = page.getByRole("dialog", { name: "Enqueue Background Task" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Dispatch Task" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("status")).toContainText("dispatched successfully");
  await expect(page.getByRole("button", { name: /Inspect job/ })).toHaveCount(2);
  expect(api.submissions()).toBe(1);
});

test("mobile layout fits the viewport and keyboard focus stays in the dialog", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApi(page);
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Inspect job/ })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("console-mobile.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Enqueue Task" }).click();
  await page.keyboard.press("Shift+Tab");
  expect(await page.evaluate(() => document.activeElement?.closest("dialog") !== null)).toBe(true);
});

test("API outage displays recovery guidance rather than a healthy empty queue", async ({ page }) => {
  await page.route("http://127.0.0.1:8000/**", (route) => route.fulfill({ headers: { "Access-Control-Allow-Origin": "*" }, status: 503, json: { detail: "Service unavailable" } }));
  await page.routeWebSocket("ws://127.0.0.1:8000/ws/jobs", () => {});
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("Could not refresh the console");
  await expect(page.getByText("Waiting for the API to reconnect.")).toBeVisible();
});
