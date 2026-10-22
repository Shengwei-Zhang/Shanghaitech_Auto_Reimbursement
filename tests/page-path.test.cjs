const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pagePath, currentBranch } = require('../dist/server/page-path.js');

/** A folder whose .git/HEAD names `branch`; `worktree` makes .git a pointer file instead. */
function repo(t, branch, worktree = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'page-path-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gitDir = worktree ? path.join(root, 'real-git-dir') : path.join(root, '.git');
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'HEAD'), branch ? `ref: refs/heads/${branch}\n` : 'a'.repeat(40));
  if (worktree) fs.writeFileSync(path.join(root, '.git'), `gitdir: ${gitDir}\n`);
  return root;
}

test('the deploy and main branches serve /Reim-Copilot, any other branch /Reim-Copilot', t => {
  assert.equal(pagePath(repo(t, 'deploy')), '/Reim-Copilot');
  assert.equal(pagePath(repo(t, 'main')), '/Reim-Copilot');
  assert.equal(pagePath(repo(t, 'dev')), '/Reim-Copilot');
  assert.equal(pagePath(repo(t, 'feature/x')), '/Reim-Copilot');
  assert.equal(pagePath(repo(t, '')), '/Reim-Copilot', 'a detached HEAD is not a release');
  assert.equal(pagePath(fs.mkdtempSync(path.join(os.tmpdir(), 'no-git-'))), '/Reim-Copilot', 'no repository at all');
  assert.equal(currentBranch(repo(t, 'deploy', true)), 'deploy', 'a worktree points to its own HEAD');
});
