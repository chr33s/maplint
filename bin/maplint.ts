#!/usr/bin/env node
import { main } from '../src/cli.js';

main(process.argv.slice(2)).then((exit: number) => { process.exitCode = exit; }, (error: unknown) => {
  console.error(`maplint: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
});
