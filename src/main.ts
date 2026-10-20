#!/usr/bin/env bun
import { runCli } from './cli.ts';

process.exit(await runCli(process.argv.slice(2)));
