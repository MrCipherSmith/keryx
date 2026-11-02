#!/usr/bin/env -S bun --no-env-file --config=/dev/null
import { hubCommand, HUB_HELP } from "./client-command";
if (import.meta.main)
    hubCommand(process.argv.slice(2), undefined, HUB_HELP.replace(/^ {2}serve.*\n/m, "")).catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : "Hub command failed");
        process.exitCode = 1;
    });
