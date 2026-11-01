'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { monthAgo, artifactPlan, releasePlan, completeRelease, cleanupArtifacts,
  cleanupReleases, REQUIRED_ASSETS } = require('./cleanup-storage.cjs');

const NOW = new Date('2026-11-01T03:00:00Z');
const SHA = 'a'.repeat(40);
const CURRENT = `patched-opencode-${SHA.slice(0, 12)}`;
const old = '2026-08-01T00:00:00Z';
const context = { repo: { owner: 'test-owner', repo: 'test-repo' }, runId: 999 };
const core = { info() {}, warning() {} };
const asset = (name) => ({ name, state: 'uploaded', size: 100 });
function release(id, date = old, tag = `patched-opencode-${String(id).padStart(12, '0')}`) {
  return { id, tag_name: tag, published_at: date, draft: false, prerelease: false,
    body: '# Patched OpenCode Build', assets: REQUIRED_ASSETS.map(asset) };
}
function artifact(id, runId, date = old, label = 'latest') {
  return { id, name: `oc-${label}-${runId}-1`, created_at: date,
    workflow_run: { id: runId }, size_in_bytes: 100 };
}
function run(id, conclusion = 'success', status = 'completed') {
  return { id, conclusion, status, release_succeeded: conclusion === 'success',
    created_at: `2026-08-${String(id).padStart(2, '0')}T00:00:00Z` };
}
function harness(options = {}) {
  const calls = { artifacts: [], releases: [], upstream: 0, lists: [] };
  const actions = {
    listArtifactsForRepo: 'artifacts', listWorkflowRuns: 'runs', listJobsForWorkflowRun: 'jobs',
    deleteArtifact: async (args) => calls.artifacts.push(args),
  };
  const repos = { listReleases: 'releases', deleteRelease: async (args) => calls.releases.push(args) };
  const github = {
    rest: { actions, repos, git: { getRef: async () => {
      calls.upstream++;
      return { data: { object: { sha: options.upstreamSha || SHA } } };
    } } },
    paginate: async (method, args) => {
      calls.lists.push(args);
      if (method === 'jobs') return options.jobs?.[args.run_id] || [];
      return options[method] || [];
    },
  };
  return { github, context, core, calls, now: NOW, builtSha: SHA, builtLabel: 'latest',
    releaseOutcome: 'success', syncOutcome: 'success', upstreamRef: 'production' };
}

test('one calendar month clamps month-end and preserves UTC time', () => {
  assert.equal(monthAgo(new Date('2026-03-31T12:34:56Z')).toISOString(), '2026-02-28T12:34:56.000Z');
  assert.equal(monthAgo(new Date('2024-03-31T12:34:56Z')).toISOString(), '2024-02-29T12:34:56.000Z');
  assert.equal(monthAgo(new Date('2026-01-01T00:00:00Z')).toISOString(), '2025-12-01T00:00:00.000Z');
});

test('artifacts: protect newest 3 successful latest-build sets, not empty cleanup-only runs', () => {
  const artifacts = [1, 2, 3, 4].map((id) => artifact(id, id));
  const runs = [...[1, 2, 3, 4].map((id) => run(id)), { ...run(5), release_succeeded: false }];
  assert.deepEqual(artifactPlan(artifacts, runs, 999, NOW).map((a) => a.id), [1]);
});

test('artifacts: fresh Release-only builds allow old duplicate artifact sets to expire', () => {
  const artifacts = [1, 2, 3, 4].map((id) => artifact(id, id));
  assert.deepEqual(artifactPlan(artifacts, [1, 2, 3, 4, 5].map((id) => run(id)), 999, NOW).map((a) => a.id), [1, 2]);
});

test('artifacts: preserve recent, exact cutoff, active, current, unrelated, and undated items', () => {
  const artifacts = [artifact(1, 1), artifact(2, 2, '2026-10-01T03:00:00Z'),
    artifact(3, 3, '2026-10-15T00:00:00Z'), artifact(4, 4), artifact(5, 999),
    { ...artifact(6, 6), name: 'another-workflow' }, artifact(7, 7, 'invalid'), artifact(8, 8)];
  const runs = [run(1, 'failure'), run(2), run(3), run(4, null, 'in_progress'), run(6), run(7)];
  assert.deepEqual(artifactPlan(artifacts, runs, 999, NOW).map((a) => a.id), [1]);
});

test('artifacts can be cleared independently of failed/fallback builds; never call Releases API', async () => {
  const h = harness({ artifacts: [artifact(1, 1)], runs: [run(1, 'failure')] });
  await cleanupArtifacts(h);
  assert.deepEqual(h.calls.artifacts, [{ ...context.repo, artifact_id: 1 }]);
  assert.equal(h.calls.releases.length, 0);
  assert.equal(h.calls.upstream, 0);
});

test('artifact API checks release + sync job steps; fallback and cleanup-only runs do not evict good builds', async () => {
  const jobs = {};
  for (const id of [1, 2, 3, 4]) {
    jobs[id] = [{ conclusion: 'success', steps: [
      { name: 'Create or update GitHub Release', conclusion: 'success' },
      { name: 'Sync patched upstream source to dev', conclusion: 'success' },
    ] }];
  }
  jobs[5] = [{ conclusion: 'success', steps: [{ name: 'Create or update GitHub Release', conclusion: 'skipped' }] }];
  const runs = [1, 2, 3, 4, 5, 6].map((id) => ({ ...run(id), release_succeeded: false }));
  const h = harness({ artifacts: [1, 2, 3, 4].map((id) => artifact(id, id)), runs, jobs });
  await cleanupArtifacts(h);
  assert.deepEqual(h.calls.artifacts.map((a) => a.artifact_id), [1]);
});

test('complete releases require every uploaded platform archive and checksums', () => {
  assert.equal(completeRelease(release(1)), true);
  for (const patch of [{ draft: true }, { prerelease: true }, { tag_name: 'manual-release' },
    { body: 'manual' }, { assets: [] }, { assets: REQUIRED_ASSETS.map((name) => ({ name, state: 'new', size: 0 })) }]) {
    assert.equal(completeRelease({ ...release(1), ...patch }), false);
  }
});

test('Releases: keep latest 3 complete and current; require both age and excess count', () => {
  const releases = [release(1), release(2, '2026-08-02T00:00:00Z'),
    release(3, '2026-08-03T00:00:00Z'), release(4, '2026-08-04T00:00:00Z'),
    release(5, '2026-10-20T00:00:00Z'), release(6, old, CURRENT),
    release(7, old, 'manual-release'), { ...release(8), assets: [] }];
  assert.deepEqual(releasePlan(releases, CURRENT, NOW).map((r) => r.id).sort((a, b) => a - b), [1, 2]);
  assert.deepEqual(releasePlan(releases, 'missing-current-release', NOW), []);
});

test('Releases: an old current release is protected even outside the newest 3', () => {
  const releases = [release(1, old, CURRENT), ...[2, 3, 4].map((id) => release(id, `2026-08-0${id}T00:00:00Z`))];
  assert.deepEqual(releasePlan(releases, CURRENT, NOW), []);
});

for (const patch of [{ builtLabel: 'fallback-last-success' }, { builtLabel: '' },
  { releaseOutcome: 'failure' }, { syncOutcome: 'failure' }, { syncOutcome: 'skipped' },
  { upstreamRef: 'old-tag' }, { builtSha: '' }]) {
  test(`Releases: failed/incomplete/custom-ref build never authorizes cleanup: ${JSON.stringify(patch)}`, async () => {
    const h = harness();
    await cleanupReleases({ ...h, ...patch });
    assert.equal(h.calls.upstream, 0);
    assert.equal(h.calls.lists.length, 0);
    assert.equal(h.calls.releases.length, 0);
  });
}

test('Releases: upstream moving ahead preserves every release', async () => {
  const h = harness({ upstreamSha: 'b'.repeat(40) });
  await cleanupReleases(h);
  assert.equal(h.calls.lists.length, 0);
  assert.equal(h.calls.releases.length, 0);
});

test('Releases: incomplete current upload preserves every release', async () => {
  const h = harness({ releases: [release(1), { ...release(2, old, CURRENT), assets: [] }] });
  await cleanupReleases(h);
  assert.equal(h.calls.releases.length, 0);
});

test('Releases: only a current, released, synced latest build prunes excess old automated releases', async () => {
  const releases = [release(1), release(2, '2026-08-02T00:00:00Z'),
    release(3, '2026-08-03T00:00:00Z'), release(4, '2026-10-20T00:00:00Z', CURRENT)];
  const h = harness({ releases });
  await cleanupReleases(h);
  assert.deepEqual(h.calls.releases, [{ ...context.repo, release_id: 1 }]);
  assert.equal(h.calls.artifacts.length, 0);
  // The mock exposes no deleteRef/deleteWorkflowRun: tags and run history are untouched.
});
