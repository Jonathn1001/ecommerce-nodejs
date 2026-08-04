import { readCsrfToken } from "../csrf";

afterEach(() => {
  document.cookie = "XSRF-TOKEN=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
});

it("reads the XSRF-TOKEN cookie", () => {
  document.cookie = "XSRF-TOKEN=abc123; path=/";
  expect(readCsrfToken()).toBe("abc123");
});

it("returns null when the cookie is absent", () => {
  expect(readCsrfToken()).toBeNull();
});

it("picks XSRF-TOKEN out of several cookies", () => {
  document.cookie = "other=1; path=/";
  document.cookie = "XSRF-TOKEN=xyz; path=/";
  expect(readCsrfToken()).toBe("xyz");
});
