#!/usr/bin/env node
/**
 * Skill Dedup Hook - Prevents local skills from shadowing global versions
 *
 * Fires: SessionStart (shadow local duplicates) + SessionEnd (restore them)
 *
 * When engineer kit is installed globally (~/.claude/skills/) and marketing kit
 * locally (.claude/skills/), Claude Code's priority system causes local skills
 * to shadow global ones. This hook temporarily moves local duplicates aside
 * during the session so global (typically newer) versions take effect.
 *
 * Flow:
 *   SessionStart: move overlapping local skills to .claude/skills/.shadowed/
 *   SessionEnd:   restore .shadowed/ skills back to .claude/skills/
 *
 * Exit Codes:
 *   0 - Success (non-blocking, allows continuation)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// -- Config ------------------------------------------------------------------

const GLOBAL_SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills');
const LOCAL_SKILLS_DIR = path.join(process.cwd(), '.claude', 'skills');
const SHADOWED_DIR = path.join(LOCAL_SKILLS_DIR, '.shadowed');
const MANIFEST_FILE = path.join(SHADOWED_DIR, '.dedup-manifest.json');

// Directories to never shadow (internal infrastructure, not real skills)
const SKIP_DIRS = new Set(['.shadowed', '.venv', 'node_modules', '__pycache__']);

// -- Helpers -----------------------------------------------------------------

/**
 * List skill directory names in a given skills root
 * Only returns directories that contain a SKILL.md (valid skills)
 */
function listSkillNames(skillsRoot) {
  if (!fs.existsSync(skillsRoot)) return [];
  try {
    return fs.readdirSync(skillsRoot, { withFileTypes: true })
      .filter(d => d.isDirectory() && !SKIP_DIRS.has(d.name))
      .filter(d => fs.existsSync(path.join(skillsRoot, d.name, 'SKILL.md')))
      .map(d => d.name);
  } catch {
    return [];
  }
}

/**
 * Find overlapping skill names between global and local installations
 */
function findOverlaps(globalSkills, localSkills) {
  const globalSet = new Set(globalSkills);
  return localSkills.filter(name => globalSet.has(name));
}

/**
 * Move a skill directory from local to shadowed
 */
function shadowSkill(skillName) {
  const src = path.join(LOCAL_SKILLS_DIR, skillName);
  const dest = path.join(SHADOWED_DIR, skillName);
  fs.renameSync(src, dest);
}

/**
 * Restore a skill directory from shadowed back to local
 */
function restoreSkill(skillName) {
  const src = path.join(SHADOWED_DIR, skillName);
  const dest = path.join(LOCAL_SKILLS_DIR, skillName);
  // Only restore if source exists and destination doesn't
  if (fs.existsSync(src) && !fs.existsSync(dest)) {
    fs.renameSync(src, dest);
  }
}

// -- SessionStart: Shadow local duplicates -----------------------------------

function handleSessionStart() {
  const globalSkills = listSkillNames(GLOBAL_SKILLS_DIR);
  const localSkills = listSkillNames(LOCAL_SKILLS_DIR);

  if (globalSkills.length === 0 || localSkills.length === 0) return;

  const overlaps = findOverlaps(globalSkills, localSkills);
  if (overlaps.length === 0) return;

  // If .shadowed/ already exists from a crashed previous session, restore first
  if (fs.existsSync(SHADOWED_DIR)) {
    handleSessionStop();
    // Re-evaluate overlaps after restoration
    const freshLocal = listSkillNames(LOCAL_SKILLS_DIR);
    const freshOverlaps = findOverlaps(globalSkills, freshLocal);
    if (freshOverlaps.length === 0) return;
    // Continue with fresh overlaps
    return doShadow(freshOverlaps);
  }

  doShadow(overlaps);
}

function doShadow(overlaps) {
  // Create .shadowed directory
  fs.mkdirSync(SHADOWED_DIR, { recursive: true });

  const shadowed = [];
  for (const name of overlaps) {
    try {
      shadowSkill(name);
      shadowed.push(name);
    } catch (err) {
      // Non-fatal: skip this skill, continue with others
      process.stderr.write(`[skill-dedup] Failed to shadow "${name}": ${err.message}\n`);
    }
  }

  if (shadowed.length === 0) return;

  // Write manifest so SessionStop knows what to restore
  const manifest = {
    shadowedAt: new Date().toISOString(),
    skills: shadowed,
    globalDir: GLOBAL_SKILLS_DIR,
    localDir: LOCAL_SKILLS_DIR
  };
  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2));

  // Output for session context
  console.log(`Skill dedup: ${shadowed.length} local skill(s) shadowed — global versions active: ${shadowed.join(', ')}`);
}

// -- SessionStop: Restore shadowed skills ------------------------------------

function handleSessionStop() {
  if (!fs.existsSync(MANIFEST_FILE)) {
    // No manifest = nothing was shadowed, or manual cleanup already done
    // Still check for orphaned .shadowed dir
    if (fs.existsSync(SHADOWED_DIR)) {
      restoreOrphanedSkills();
    }
    return;
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
  } catch {
    // Corrupt manifest — attempt blind restore
    restoreOrphanedSkills();
    return;
  }

  const restored = [];
  for (const name of manifest.skills || []) {
    try {
      restoreSkill(name);
      restored.push(name);
    } catch (err) {
      process.stderr.write(`[skill-dedup] Failed to restore "${name}": ${err.message}\n`);
    }
  }

  // Clean up .shadowed directory
  cleanupShadowedDir();

  if (restored.length > 0) {
    console.log(`Skill dedup: restored ${restored.length} local skill(s): ${restored.join(', ')}`);
  }
}

/**
 * Restore any skill directories found in .shadowed/ without a manifest
 * Safety net for crashed sessions or corrupt manifests
 */
function restoreOrphanedSkills() {
  try {
    const entries = fs.readdirSync(SHADOWED_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        restoreSkill(entry.name);
      }
    }
  } catch {
    // Best effort
  }
  cleanupShadowedDir();
}

/**
 * Remove the .shadowed directory and manifest
 */
function cleanupShadowedDir() {
  try {
    // Remove manifest file first
    if (fs.existsSync(MANIFEST_FILE)) fs.unlinkSync(MANIFEST_FILE);
    // Remove directory (should be empty now)
    if (fs.existsSync(SHADOWED_DIR)) fs.rmdirSync(SHADOWED_DIR);
  } catch {
    // Non-fatal: leftover empty dir is harmless
  }
}

// -- Main --------------------------------------------------------------------

function main() {
  try {
    // Read hook event from stdin payload
    let payload = {};
    try {
      const input = fs.readFileSync('/dev/stdin', 'utf8').trim();
      if (input) payload = JSON.parse(input);
    } catch {
      // No stdin or invalid JSON — determine mode from .shadowed existence
    }

    const event = payload.hook_event_name || '';

    if (event === 'SessionEnd' || event === 'Stop') {
      handleSessionStop();
    } else {
      // Default: SessionStart behavior (also handles startup, resume, clear, compact)
      handleSessionStart();
    }
  } catch (err) {
    // Fail open — never block session startup/shutdown
    process.stderr.write(`[skill-dedup] Error: ${err.message}\n`);
  }

  process.exit(0);
}

main();
