import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
export default defineConfig({ plugins: [react()], test: { environment: "jsdom", include: ["tests/**/*.case.ts", "tests/**/*.case.tsx"], setupFiles: ["tests/setup.ts"], globals: true, restoreMocks: true } });
