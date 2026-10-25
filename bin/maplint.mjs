#!/usr/bin/env node
import { main } from '../src/cli.mjs';
main(process.argv.slice(2)).then((exit) => { process.exitCode = exit; }, (e) => {
  console.error(`maplint: ${e.message}`);
  process.exitCode = 2;
});
