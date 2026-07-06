import { stdin as input, stdout as output } from "node:process";
import readline from "node:readline/promises";

export async function confirm(
  question: string,
  defaultValue = false,
): Promise<boolean> {
  if (!input.isTTY) {
    return defaultValue;
  }

  const suffix = defaultValue ? "Y/n" : "y/N";
  const rl = readline.createInterface({ input, output });

  try {
    const answer = await rl.question(`${question} (${suffix}) `);
    const normalized = answer.trim().toLowerCase();

    if (!normalized) {
      return defaultValue;
    }

    return normalized === "y" || normalized === "yes";
  } finally {
    rl.close();
  }
}
