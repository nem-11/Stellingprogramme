#!/usr/bin/env node
'use strict';

/** Apply one-off W/C Air and Sound programme items to module zones. */

const db = require('./db');

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  await db.init();
  const out = db.applyModuleAirSoundOneOffs({ dryRun });
  console.log(JSON.stringify(out, null, 2));
  if (out.error) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
