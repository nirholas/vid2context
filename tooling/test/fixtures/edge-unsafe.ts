import { readFile } from 'node:fs/promises';
import path from 'path';
export * from 'node:events';
import type { Ctx } from '@vid2context/core';
import { helper } from './helper.ts';
// import { spawn } from 'node:child_process';  (a comment, ignored)
const os = await import('os');
const cp = require('child_process');
export { readFile, path, os, cp, helper };
export type { Ctx };
