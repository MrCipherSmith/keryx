import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import i18n from "../src/i18n";
import { ThemeSelect } from "../src/theme";

test("explicit theme changes document and persists only appearance preference", async () => {
  await act(() => i18n.changeLanguage("en"));
  render(<ThemeSelect />);
  fireEvent.click(screen.getByRole("button", { name: "Dark" }));
  expect(screen.getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "true");
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(localStorage.getItem("keryx.hub.theme")).toBe("dark");
  fireEvent.click(screen.getByRole("button", { name: "Light" }));
  expect(document.documentElement.dataset.theme).toBe("light");
});

test("system mode follows OS changes but explicit mode ignores them", async () => {
  const media = new EventTarget();
  let dark = false;
  Object.defineProperty(media, "matches", { get: () => dark });
  vi.stubGlobal("matchMedia", () => media);
  render(<ThemeSelect />);
  fireEvent.click(screen.getByRole("button", { name: "System" }));
  act(() => {
    dark = true;
    media.dispatchEvent(new Event("change"));
  });
  expect(document.documentElement.dataset.theme).toBe("dark");
  fireEvent.click(screen.getByRole("button", { name: "Light" }));
  act(() => {
    dark = false;
    media.dispatchEvent(new Event("change"));
    dark = true;
    media.dispatchEvent(new Event("change"));
  });
  expect(document.documentElement.dataset.theme).toBe("light");
  vi.unstubAllGlobals();
});
