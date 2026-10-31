#!/usr/bin/env -S bun --no-env-file --config=/dev/null
import { hubCommand } from "./client-command";
if (import.meta.main)
    hubCommand(process.argv.slice(2)).catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : "Hub command failed");
        process.exitCode = 1;
    });
