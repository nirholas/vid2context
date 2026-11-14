/** Writes schema/config.schema.json from the validator's own definitions. Run: npm run gen:schema -w packages/config */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { configJsonSchema } from '../src/index.ts';

const out = fileURLToPath(new URL('../schema/config.schema.json', import.meta.url));
writeFileSync(out, `${JSON.stringify(configJsonSchema(), null, 2)}\n`);
console.error(`wrote ${out}`);
