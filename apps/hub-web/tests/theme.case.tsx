import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import i18n from "../src/i18n";
import { ThemeSelect } from "../src/theme";

test("explicit theme changes document and persists only appearance preference", async () => {
  await act(() => i18n.changeLanguage("en"));
  render(<ThemeSelect />);
  fireEvent.change(screen.getByLabelText("Appearance"), {
    target: { value: "dark" },
  });
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(localStorage.getItem("keryx.hub.theme")).toBe("dark");
  fireEvent.change(screen.getByLabelText("Appearance"), {
    target: { value: "light" },
  });
  expect(document.documentElement.dataset.theme).toBe("light");
});

test("system mode follows OS changes but explicit mode ignores them", async () => {
  const media = new EventTarget();
  let dark = false;
  Object.defineProperty(media, "matches", { get: () => dark });
  vi.stubGlobal("matchMedia", () => media);
  render(<ThemeSelect />);
  const selector = screen.getByLabelText("Appearance");
  fireEvent.change(selector, { target: { value: "system" } });
  act(() => {
    dark = true;
    media.dispatchEvent(new Event("change"));
  });
  expect(document.documentElement.dataset.theme).toBe("dark");
  fireEvent.change(selector, { target: { value: "light" } });
  act(() => {
    dark = false;
    media.dispatchEvent(new Event("change"));
    dark = true;
    media.dispatchEvent(new Event("change"));
  });
  expect(document.documentElement.dataset.theme).toBe("light");
  vi.unstubAllGlobals();
});
