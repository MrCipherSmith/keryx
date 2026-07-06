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

export async function choice<T extends string>(
  question: string,
  choices: readonly T[],
  defaultValue: T,
): Promise<T> {
  if (!input.isTTY) {
    return defaultValue;
  }

  const rl = readline.createInterface({ input, output });

  try {
    const answer = await rl.question(
      `${question} (${choices.join("/")}; default: ${defaultValue}) `,
    );
    const normalized = answer.trim().toLowerCase();
    const match = choices.find((item) => item.toLowerCase() === normalized);
    return match ?? defaultValue;
  } finally {
    rl.close();
  }
}
