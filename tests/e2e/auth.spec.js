import { test, expect } from "@playwright/test";

test("password sign-in explains rejected credentials and never falls back to creating a user", async ({
  page,
}) => {
  let calls = 0;
  await page.route(
    "https://signatureflow-test.supabase.co/auth/v1/**",
    async (route) => {
      const req = route.request();
      expect(req.url()).toContain("token?grant_type=password");
      expect(req.postDataJSON()).toMatchObject({
        email: "organisateur@example.fr",
        password: "mot-de-passe-test",
      });
      calls++;
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          error: "invalid_grant",
          error_description: "Invalid login credentials",
        }),
      });
    },
  );
  await page.goto("/");
  await expect(page.locator(".version")).toHaveText("v2.1.1");
  await page.locator("#email").fill("organisateur@example.fr");
  await page.locator("#password").fill("mot-de-passe-test");
  await page.locator("#showPassword").check();
  await expect(page.locator("#password")).toHaveAttribute("type", "text");
  await page.getByRole("button", { name: "Se connecter" }).click();
  await expect(page.locator("#notice")).toContainText(
    "E-mail ou mot de passe incorrect",
  );
  expect(calls).toBe(1);
});

test("password recovery sends the explicit SignatureFlow callback", async ({
  page,
}) => {
  let callback = "";
  await page.route(
    "https://signatureflow-test.supabase.co/auth/v1/recover**",
    async (route) => {
      callback = new URL(route.request().url()).searchParams.get("redirect_to");
      expect(route.request().postDataJSON().email).toBe(
        "organisateur@example.fr",
      );
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "{}",
      });
    },
  );
  await page.goto("/");
  await page.locator("#email").fill("organisateur@example.fr");
  await page.locator("#resetPassword").click();
  await expect(page.locator("#notice")).toContainText("Si ce compte existe");
  expect(callback).toBe("http://127.0.0.1:5173/?recovery=1");
});
