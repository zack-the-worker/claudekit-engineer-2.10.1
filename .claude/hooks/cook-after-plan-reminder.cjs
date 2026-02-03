#!/usr/bin/env node
/**
 * Plan Subagent Stop Hook - Cook Skill Reminder
 *
 * Fires when Plan subagent completes. Reminds to invoke /cook --auto before implementation.
 *
 * Exit Codes:
 *   0 - Success (non-blocking)
 */

const fs = require('fs');
const { isHookEnabled } = require('./lib/ck-config-utils.cjs');

// Early exit if hook disabled in config
if (!isHookEnabled('cook-after-plan-reminder')) {
  process.exit(0);
}

async function main() {
  try {
    const stdin = fs.readFileSync(0, 'utf-8').trim();
    if (!stdin) process.exit(0);

    // Output reminder to invoke cook skill
    console.log('MUST invoke /cook --auto skill before implementing the plan');
    process.exit(0);
  } catch (error) {
    // Silent fail - non-blocking
    process.exit(0);
  }
}

main();
