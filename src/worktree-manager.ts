/**
 * worktree-manager.ts — Git worktree lifecycle management for coding mode teammates.
 *
 * Creates, tracks, merges, and removes git worktrees so each coding agent teammate
 * gets its own isolated copy of the codebase (separate working directory + branch),
 * preventing file conflicts during parallel execution.
 *
 * Phase 8.39: Git Worktree Isolation for Tappi Browser.
 */

import { execSync, ExecSyncOptions } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface WorktreeInfo {
  name: string;          // e.g., "backend"
  path: string;          // absolute path to worktree directory
  branch: string;        // e.g., "wt-backend"
  baseBranch: string;    // branch it was forked from (e.g., "main")
  repoPath: string;      // root git repo path
  createdAt: string;     // ISO timestamp
  teammateId?: string;   // linked teammate name if part of a team
  status: 'active' | 'merging' | 'cleanup';
}

export interface MergeResult {
  success: boolean;
  conflicts?: string[];
  message: string;
}

export interface RemoveResult {
  removed: boolean;
  hadChanges: boolean;
  message: string;
}

// ─── Singleton Instance ───────────────────────────────────────────────────────

// All worktrees managed in this session (keyed by name)
const activeWorktrees = new Map<string, WorktreeInfo>();

// ─── WorktreeManager ─────────────────────────────────────────────────────────

export class WorktreeManager {
  private repoPath: string;

  constructor(repoPath: string) {
    this.repoPath = this.resolveRepoRoot(repoPath);
  }

  /**
   * Resolve the actual git repo root from any path inside the repo.
   */
  private resolveRepoRoot(p: string): string {
    const expanded = p.replace(/^~/, process.env.HOME || process.env.USERPROFILE || '.');
    try {
      const root = this.git('rev-parse --show-toplevel', expanded).trim();
      return root;
    } catch {
      return expanded;
    }
  }

  /**
   * Run a git command inside the repo. Returns stdout string.
   */
  private git(cmd: string, cwd?: string, opts?: ExecSyncOptions): string {
    const workdir = cwd || this.repoPath;
    try {
      const result = execSync(`git ${cmd}`, {
        cwd: workdir,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        ...opts,
      }) as string;
      return result || '';
    } catch (err: any) {
      const stderr = err?.stderr?.toString() || '';
      const stdout = err?.stdout?.toString() || '';
      throw new Error(stderr || stdout || err?.message || `git ${cmd} failed`);
    }
  }

  /**
   * Check if a path is inside a git repository.
   */
  isGitRepo(checkPath?: string): boolean {
    const p = checkPath
      ? (checkPath.replace(/^~/, process.env.HOME || process.env.USERPROFILE || '.'))
      : this.repoPath;
    try {
      execSync('git rev-parse --git-dir', {
        cwd: p,
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if the current directory is already inside a worktree (not the main working tree).
   */
  isInsideWorktree(): boolean {
    try {
      const gitDir = this.git('rev-parse --git-dir').trim();
      // In a worktree, git dir looks like ".git/worktrees/<name>"
      return gitDir.includes('worktrees');
    } catch {
      return false;
    }
  }

  /**
   * Get the default remote branch (main, master, etc.).
   */
  getDefaultBranch(): string {
    try {
      // Try to get the HEAD ref of origin
      const ref = this.git('symbolic-ref refs/remotes/origin/HEAD').trim();
      return ref.replace('refs/remotes/origin/', '');
    } catch {
      // Fallback: check if main or master exists
      try {
        this.git('rev-parse --verify origin/main');
        return 'main';
      } catch {
        try {
          this.git('rev-parse --verify origin/master');
          return 'master';
        } catch {
          // Last resort: current branch
          try {
            return this.git('rev-parse --abbrev-ref HEAD').trim();
          } catch {
            return 'main';
          }
        }
      }
    }
  }

  /**
   * Get the current branch of the repo.
   */
  getCurrentBranch(): string {
    try {
      return this.git('rev-parse --abbrev-ref HEAD').trim();
    } catch {
      return 'main';
    }
  }

  /**
   * Auto-add .tappi-worktrees/ to .gitignore if not already present.
   */
  private ensureGitignore(): void {
    const gitignorePath = path.join(this.repoPath, '.gitignore');
    const entry = '.tappi-worktrees/';

    try {
      if (fs.existsSync(gitignorePath)) {
        const content = fs.readFileSync(gitignorePath, 'utf-8');
        if (!content.includes(entry)) {
          fs.appendFileSync(gitignorePath, `\n# Tappi Browser worktrees (auto-generated)\n${entry}\n`);
        }
      } else {
        fs.writeFileSync(gitignorePath, `# Tappi Browser worktrees (auto-generated)\n${entry}\n`);
      }
    } catch {
      // Non-fatal: gitignore write failure doesn't block worktree creation
    }
  }

  /**
   * Create a new worktree for a teammate or standalone session.
   */
  async createWorktree(opts: {
    name: string;               // e.g., "backend" (without @)
    baseBranch?: string;        // defaults to default remote branch
    teammateId?: string;        // teammate name if part of a team
  }): Promise<WorktreeInfo> {
    const { name, teammateId } = opts;

    if (!this.isGitRepo()) {
      throw new Error(`Not a git repository: ${this.repoPath}`);
    }

    if (this.isInsideWorktree()) {
      throw new Error('Cannot create nested worktrees. Already inside a worktree.');
    }

    // Sanitize name: strip @ prefix, replace spaces with hyphens, lowercase
    const cleanName = name.replace(/^@/, '').replace(/\s+/g, '-').toLowerCase();
    const branchName = `wt-${cleanName}`;
    const worktreeDir = path.join(this.repoPath, '.tappi-worktrees', cleanName);
    const baseBranch = opts.baseBranch || this.getDefaultBranch();

    // Check if branch already exists
    let branchExists = false;
    try {
      this.git(`rev-parse --verify ${branchName}`);
      branchExists = true;
    } catch {
      branchExists = false;
    }

    // Check if worktree directory already exists
    if (fs.existsSync(worktreeDir)) {
      // Worktree already exists - return its info
      const existing = activeWorktrees.get(cleanName);
      if (existing) return existing;

      // Reconstruct info
      const info: WorktreeInfo = {
        name: cleanName,
        path: worktreeDir,
        branch: branchName,
        baseBranch,
        repoPath: this.repoPath,
        createdAt: new Date().toISOString(),
        teammateId,
        status: 'active',
      };
      activeWorktrees.set(cleanName, info);
      return info;
    }

    // Ensure .tappi-worktrees/ is in .gitignore
    this.ensureGitignore();

    // Create the worktrees directory if needed
    const worktreesBaseDir = path.join(this.repoPath, '.tappi-worktrees');
    if (!fs.existsSync(worktreesBaseDir)) {
      fs.mkdirSync(worktreesBaseDir, { recursive: true });
    }

    // Create worktree + branch
    if (branchExists) {
      // Branch exists: add worktree pointing to existing branch
      this.git(`worktree add "${worktreeDir}" "${branchName}"`);
    } else {
      // Create new branch from base branch
      let baseSHA: string;
      try {
        baseSHA = this.git(`rev-parse origin/${baseBranch}`).trim();
      } catch {
        // No remote origin — use local branch
        try {
          baseSHA = this.git(`rev-parse ${baseBranch}`).trim();
        } catch {
          // Use HEAD
          baseSHA = this.git('rev-parse HEAD').trim();
        }
      }
      this.git(`worktree add -b "${branchName}" "${worktreeDir}" "${baseSHA}"`);
    }

    const info: WorktreeInfo = {
      name: cleanName,
      path: worktreeDir,
      branch: branchName,
      baseBranch,
      repoPath: this.repoPath,
      createdAt: new Date().toISOString(),
      teammateId,
      status: 'active',
    };

    activeWorktrees.set(cleanName, info);
    console.log(`[worktree] Created: ${cleanName} at ${worktreeDir} (branch: ${branchName})`);

    return info;
  }

  /**
   * List all worktrees managed in this session + any found in the repo.
   */
  listWorktrees(): WorktreeInfo[] {
    if (!this.isGitRepo()) return [];

    // Parse git's worktree list output
    const repoWorktrees: WorktreeInfo[] = [];
    try {
      const raw = this.git('worktree list --porcelain');
      const blocks = raw.split('\n\n').filter(Boolean);
      for (const block of blocks) {
        const lines = block.trim().split('\n');
        const worktreePath = lines.find(l => l.startsWith('worktree '))?.slice('worktree '.length) || '';
        const branch = lines.find(l => l.startsWith('branch '))?.slice('branch '.length).replace('refs/heads/', '') || '';

        // Only include Tappi-managed worktrees
        if (!worktreePath.includes('.tappi-worktrees')) continue;

        const name = path.basename(worktreePath);
        const existing = activeWorktrees.get(name);
        repoWorktrees.push({
          name,
          path: worktreePath,
          branch,
          baseBranch: existing?.baseBranch || this.getDefaultBranch(),
          repoPath: this.repoPath,
          createdAt: existing?.createdAt || new Date().toISOString(),
          teammateId: existing?.teammateId,
          status: existing?.status || 'active',
        });
      }
    } catch {
      // Return in-memory list on parse failure
      return Array.from(activeWorktrees.values());
    }

    return repoWorktrees;
  }

  /**
   * Check for uncommitted changes in a worktree.
   */
  hasUncommittedChanges(worktreePath: string): boolean {
    try {
      const status = execSync('git status --porcelain', {
        cwd: worktreePath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return (status || '').trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Remove a worktree and its branch.
   */
  async removeWorktree(name: string, opts: { force?: boolean } = {}): Promise<RemoveResult> {
    const cleanName = name.replace(/^@/, '').replace(/\s+/g, '-').toLowerCase();
    const info = activeWorktrees.get(cleanName);
    const worktreeDir = info?.path || path.join(this.repoPath, '.tappi-worktrees', cleanName);
    const branchName = info?.branch || `wt-${cleanName}`;

    if (!fs.existsSync(worktreeDir)) {
      activeWorktrees.delete(cleanName);
      return { removed: true, hadChanges: false, message: `Worktree "${cleanName}" not found on disk (already removed).` };
    }

    const hadChanges = this.hasUncommittedChanges(worktreeDir);
    if (hadChanges && !opts.force) {
      return {
        removed: false,
        hadChanges: true,
        message: `Worktree "${cleanName}" has uncommitted changes. Use force=true to remove anyway, or merge first.`,
      };
    }

    try {
      // Remove worktree
      if (opts.force) {
        this.git(`worktree remove --force "${worktreeDir}"`);
      } else {
        this.git(`worktree remove "${worktreeDir}"`);
      }
    } catch (e: any) {
      // Fallback: if git worktree remove fails (e.g., locked), force via fs
      try {
        this.git(`worktree remove --force "${worktreeDir}"`);
      } catch {
        // Manual cleanup
        try {
          fs.rmSync(worktreeDir, { recursive: true, force: true });
          this.git('worktree prune');
        } catch {}
      }
    }

    // Delete the branch
    try {
      this.git(`branch -D "${branchName}"`);
    } catch {
      // Branch may not exist or may be checked out elsewhere — non-fatal
    }

    activeWorktrees.delete(cleanName);
    console.log(`[worktree] Removed: ${cleanName}`);

    return {
      removed: true,
      hadChanges,
      message: `✓ Worktree "${cleanName}" removed${hadChanges ? ' (had uncommitted changes — forced)' : ''}.`,
    };
  }

  /**
   * Merge a worktree branch back into the base branch.
   */
  async mergeWorktree(
    name: string,
    opts: {
      strategy?: 'merge' | 'squash' | 'cherry-pick';
      message?: string;
    } = {},
  ): Promise<MergeResult> {
    const cleanName = name.replace(/^@/, '').replace(/\s+/g, '-').toLowerCase();
    const info = activeWorktrees.get(cleanName);
    const branchName = info?.branch || `wt-${cleanName}`;
    const baseBranch = info?.baseBranch || this.getDefaultBranch();
    const strategy = opts.strategy || 'squash';
    const commitMsg = opts.message || `[tappi] Merge ${branchName} (${cleanName}) into ${baseBranch}`;

    if (!this.isGitRepo()) {
      return { success: false, message: 'Not a git repository.' };
    }

    // Update worktree status
    if (info) info.status = 'merging';

    try {
      // Check for uncommitted changes in worktree
      const worktreeDir = info?.path || path.join(this.repoPath, '.tappi-worktrees', cleanName);
      if (fs.existsSync(worktreeDir) && this.hasUncommittedChanges(worktreeDir)) {
        // Auto-commit uncommitted changes before merging
        execSync('git add -A && git commit -m "[tappi] Auto-commit before merge"', {
          cwd: worktreeDir,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      }

      // Switch to base branch in main repo
      const currentBranch = this.getCurrentBranch();
      if (currentBranch !== baseBranch) {
        try {
          this.git(`checkout "${baseBranch}"`);
        } catch {
          // May already be there or detached HEAD — proceed
        }
      }

      // Run the merge
      let mergeOutput = '';
      if (strategy === 'squash') {
        mergeOutput = this.git(`merge --squash "${branchName}"`);
        this.git(`commit -m "${commitMsg.replace(/"/g, '\\"')}"`);
      } else if (strategy === 'cherry-pick') {
        // Get all commits on the branch not in base
        const commits = this.git(`log --oneline ${baseBranch}..${branchName}`).trim();
        if (!commits) {
          return { success: true, message: `No commits to cherry-pick from "${branchName}".` };
        }
        // Cherry-pick in order (oldest first)
        const hashes = commits
          .split('\n')
          .map(l => l.split(' ')[0])
          .reverse();
        for (const hash of hashes) {
          this.git(`cherry-pick "${hash}"`);
        }
        mergeOutput = `Cherry-picked ${hashes.length} commit(s)`;
      } else {
        // Regular merge
        mergeOutput = this.git(`merge "${branchName}" -m "${commitMsg.replace(/"/g, '\\"')}"`);
      }

      if (info) info.status = 'active';
      console.log(`[worktree] Merged ${branchName} → ${baseBranch} (strategy: ${strategy})`);
      return {
        success: true,
        message: `✓ Merged "${branchName}" into "${baseBranch}" (strategy: ${strategy}).`,
      };
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      // Detect conflicts
      if (errMsg.includes('CONFLICT') || errMsg.includes('conflict')) {
        let conflicts: string[] = [];
        try {
          const conflictFiles = this.git('diff --name-only --diff-filter=U');
          conflicts = conflictFiles.trim().split('\n').filter(Boolean);
        } catch {}
        if (info) info.status = 'active';
        return {
          success: false,
          conflicts,
          message: `⚠️ Merge conflicts in: ${conflicts.join(', ')}. Resolve manually and commit.`,
        };
      }
      if (info) info.status = 'active';
      return {
        success: false,
        message: `❌ Merge failed: ${errMsg.slice(0, 300)}`,
      };
    }
  }

  /**
   * Get git status of a specific worktree.
   */
  worktreeStatus(name: string): string {
    const cleanName = name.replace(/^@/, '').replace(/\s+/g, '-').toLowerCase();
    const info = activeWorktrees.get(cleanName);
    const worktreeDir = info?.path || path.join(this.repoPath, '.tappi-worktrees', cleanName);

    if (!fs.existsSync(worktreeDir)) {
      return `❌ Worktree "${cleanName}" not found.`;
    }

    try {
      const status = execSync('git status', {
        cwd: worktreeDir,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const log = execSync('git log --oneline -5', {
        cwd: worktreeDir,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      return `**Worktree: ${cleanName}** (branch: ${info?.branch || `wt-${cleanName}`})\n\n${status}\n\nRecent commits:\n${log}`;
    } catch (e: any) {
      return `❌ Status failed: ${e?.message || e}`;
    }
  }

  /**
   * Show diff between worktree branch and base branch.
   */
  worktreeDiff(name: string): string {
    const cleanName = name.replace(/^@/, '').replace(/\s+/g, '-').toLowerCase();
    const info = activeWorktrees.get(cleanName);
    const branchName = info?.branch || `wt-${cleanName}`;
    const baseBranch = info?.baseBranch || this.getDefaultBranch();

    try {
      const diff = this.git(`diff ${baseBranch}...${branchName} --stat`);
      const fullDiff = this.git(`diff ${baseBranch}...${branchName}`);
      const truncated = fullDiff.length > 4000 ? fullDiff.slice(0, 4000) + '\n... (truncated)' : fullDiff;
      return `**Diff: ${branchName} vs ${baseBranch}**\n\n${diff}\n\n${truncated}`;
    } catch (e: any) {
      return `❌ Diff failed: ${e?.message || e}`;
    }
  }

  /**
   * Detect and report stale worktrees (older than 24h with no activity).
   * Returns list of stale worktree names for cleanup prompting.
   */
  detectStaleWorktrees(): WorktreeInfo[] {
    const stale: WorktreeInfo[] = [];
    const cutoff = Date.now() - 24 * 60 * 60 * 1000; // 24h ago

    for (const [, info] of activeWorktrees) {
      const created = new Date(info.createdAt).getTime();
      if (created < cutoff) {
        stale.push(info);
      }
    }

    // Also check worktrees on disk that we don't know about
    const worktreesBaseDir = path.join(this.repoPath, '.tappi-worktrees');
    if (fs.existsSync(worktreesBaseDir)) {
      try {
        const dirs = fs.readdirSync(worktreesBaseDir);
        for (const dir of dirs) {
          if (!activeWorktrees.has(dir)) {
            const fullPath = path.join(worktreesBaseDir, dir);
            const stats = fs.statSync(fullPath);
            if (stats.ctimeMs < cutoff) {
              stale.push({
                name: dir,
                path: fullPath,
                branch: `wt-${dir}`,
                baseBranch: this.getDefaultBranch(),
                repoPath: this.repoPath,
                createdAt: stats.ctime.toISOString(),
                status: 'active',
              });
            }
          }
        }
      } catch {}
    }

    return stale;
  }

  /**
   * Prune any dead worktree entries from git's tracking.
   */
  pruneWorktrees(): void {
    try {
      this.git('worktree prune');
    } catch {}
  }
}

// ─── Module-level singleton helpers ──────────────────────────────────────────

/**
 * Create a WorktreeManager for a given repo path.
 * Returns null if the path is not a git repository.
 */
export function createWorktreeManager(repoPath: string): WorktreeManager | null {
  const expanded = repoPath.replace(/^~/, process.env.HOME || process.env.USERPROFILE || '.');
  const manager = new WorktreeManager(expanded);
  if (!manager.isGitRepo(expanded)) return null;
  return manager;
}

/**
 * Get active worktree info by name (across all managers).
 */
export function getWorktreeInfo(name: string): WorktreeInfo | undefined {
  const cleanName = name.replace(/^@/, '').replace(/\s+/g, '-').toLowerCase();
  return activeWorktrees.get(cleanName);
}

/**
 * Clear all tracked worktrees (on app exit / team dissolve).
 */
export function clearWorktreeRegistry(): void {
  activeWorktrees.clear();
}
