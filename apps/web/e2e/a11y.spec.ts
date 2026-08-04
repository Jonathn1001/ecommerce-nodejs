import { test, expect } from "@playwright/test";

// These two checks exist against the SHIPPED stylesheet, not against source, because that is
// where 8a's Tailwind traps lived: a @theme block hoisted out of its media query, and colours
// tree-shaken away because arbitrary values did not count as references. Every jsdom test in
// the repo passed over both.

test("the pulse stops under prefers-reduced-motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");

  const animation = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.className = "tracker-pulse";
    document.body.append(probe);
    const name = getComputedStyle(probe).animationName;
    probe.remove();
    return name;
  });
  expect(animation).toBe("none");
});

test("the pulse runs when motion is allowed", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");

  const animation = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.className = "tracker-pulse";
    document.body.append(probe);
    const name = getComputedStyle(probe).animationName;
    probe.remove();
    return name;
  });
  // Proves the reduced-motion assertion above is measuring something, rather than passing
  // because the rule was never emitted at all.
  expect(animation).toBe("tracker-pulse");
});

test("the first tab stop is the skip link, and focus is visible", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Tab");

  const focused = page.locator(":focus");
  await expect(focused).toHaveText(/skip to content/i);

  const outline = await focused.evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline).not.toBe("none");
});
