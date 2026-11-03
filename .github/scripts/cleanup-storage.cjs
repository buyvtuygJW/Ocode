'use strict';

// Repository-local retention. Never delete tags, workflow runs, or manual releases.
const WORKFLOW = 'weekly_customautorel.yml';
const KEEP = 3;
const ARTIFACT = /^oc-(latest|fallback-last-success)-\d+-\d+$/;
const RELEASE = /^patched-opencode-[0-9a-f]{12}$/;
const REQUIRED_ASSETS = [
  'opencode-windows-x64-custom.zip',
  'opencode-windows-x64-baseline-custom.zip',
  'opencode-linux-x64-custom.tar.gz',
  'opencode-linux-x64-baseline-custom.tar.gz',
  'opencode-linux-arm64-custom.tar.gz',
  'opencode-darwin-x64-custom.zip',
  'opencode-darwin-x64-baseline-custom.zip',
  'opencode-darwin-arm64-custom.zip',
  'SHA256SUMS.txt',
];

function monthAgo(now) {
  const cutoff = new Date(now);
  const day = cutoff.getUTCDate();
  cutoff.setUTCDate(1);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - 1);
  const lastDay = new Date(Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() + 1, 0)).getUTCDate();
  cutoff.setUTCDate(Math.min(day, lastDay));
  return cutoff;
}

function oldEnough(timestamp, cutoff) {
  const time = Date.parse(timestamp);
  return Number.isFinite(time) && time < cutoff.getTime();
}

function artifactPlan(artifacts, runs, currentRunId, now) {
  const cutoff = monthAgo(now);
  const ours = artifacts.filter((a) => ARTIFACT.test(a.name));
  const workflowRunIds = new Set(runs.map((r) => r.id));
  const protectedRuns = new Set(runs
    .filter((r) => r.conclusion === 'success' && r.release_succeeded)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(0, KEEP).map((r) => r.id));
  for (const run of runs) {
    if (run.status !== 'completed') protectedRuns.add(run.id);
  }
  protectedRuns.add(Number(currentRunId));
  return ours.filter((a) => workflowRunIds.has(a.workflow_run?.id) &&
    !protectedRuns.has(a.workflow_run.id) && oldEnough(a.created_at, cutoff));
}

function completeRelease(release) {
  if (release.draft || release.prerelease || !RELEASE.test(release.tag_name)) return false;
  if (!release.body?.includes('# Patched OpenCode Build')) return false;
  const assets = new Set((release.assets || [])
    .filter((a) => a.state === 'uploaded' && a.size > 0).map((a) => a.name));
  return REQUIRED_ASSETS.every((name) => assets.has(name));
}

function releasePlan(releases, currentTag, now) {
  const complete = releases.filter(completeRelease)
    .sort((a, b) => Date.parse(b.published_at || b.created_at) - Date.parse(a.published_at || a.created_at));
  // A partial/failed current upload can never authorize deleting an older release.
  if (!complete.some((r) => r.tag_name === currentTag)) return [];
  const protectedTags = new Set(complete.slice(0, KEEP).map((r) => r.tag_name));
  protectedTags.add(currentTag); // also protect an explicitly rerun old upstream SHA
  const cutoff = monthAgo(now);
  return complete.filter((r) => !protectedTags.has(r.tag_name) &&
    oldEnough(r.published_at || r.created_at, cutoff));
}

async function cleanupArtifacts({ github, context, core, now = new Date() }) {
  const scope = context.repo;
  const artifacts = await github.paginate(github.rest.actions.listArtifactsForRepo, { ...scope, per_page: 100 });
  if (!artifacts.some((a) => ARTIFACT.test(a.name))) {
    core.info('No matching OpenCode Actions artifacts.');
    return;
  }
  const runs = await github.paginate(github.rest.actions.listWorkflowRuns, {
    ...scope, workflow_id: WORKFLOW, per_page: 100,
  });
  // New Release-first builds have no duplicate artifact. They must still count
  // toward the three protected builds, or old artifact sets would live forever.
  let verified = 0;
  for (const run of runs.filter((r) => r.conclusion === 'success')
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))) {
    const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
      ...scope, run_id: run.id, filter: 'latest', per_page: 100,
    });
    run.release_succeeded = jobs.some((job) => job.conclusion === 'success' &&
      ['Create or update GitHub Release', 'Sync patched upstream source to dev']
        .every((name) => job.steps?.some((step) => step.name === name && step.conclusion === 'success')));
    if (run.release_succeeded && ++verified === KEEP) break;
  }
  const candidates = artifactPlan(artifacts, runs, context.runId, now);
  let bytes = 0;
  for (const artifact of candidates) {
    core.info(`Deleting old Actions artifact ${artifact.id}: ${artifact.name} (${artifact.size_in_bytes} bytes)`);
    await github.rest.actions.deleteArtifact({ ...scope, artifact_id: artifact.id });
    bytes += artifact.size_in_bytes || 0;
  }
  core.info(`Deleted ${candidates.length} Actions artifacts (${bytes} bytes). Kept newest ${KEEP} successful latest-build artifact sets and everything under one month old.`);
}

async function cleanupReleases({ github, context, core, builtSha, builtLabel,
  releaseOutcome, syncOutcome, upstreamRef, now = new Date() }) {
  if (builtLabel !== 'latest' || releaseOutcome !== 'success' || syncOutcome !== 'success' ||
      upstreamRef !== 'production' || !/^[0-9a-f]{40}$/.test(builtSha || '')) {
    core.info('Keeping all Releases: latest production build, release publishing and dev sync must all succeed.');
    return;
  }
  // Do not prune when this build is already behind a newer upstream commit.
  const upstream = await github.rest.git.getRef({ owner: 'anomalyco', repo: 'opencode', ref: 'heads/production' });
  if (upstream.data.object.sha !== builtSha) {
    core.warning('Keeping all Releases: upstream production has moved ahead of this build.');
    return;
  }
  const releases = await github.paginate(github.rest.repos.listReleases, { ...context.repo, per_page: 100 });
  const currentTag = `patched-opencode-${builtSha.slice(0, 12)}`;
  if (!releases.some((r) => r.tag_name === currentTag && completeRelease(r))) {
    core.warning('Keeping all Releases: the current release does not contain every platform archive and SHA256SUMS.txt.');
    return;
  }
  const candidates = releasePlan(releases, currentTag, now);
  for (const release of candidates) {
    core.info(`Deleting old automated Release ${release.tag_name}; leaving its git tag intact.`);
    await github.rest.repos.deleteRelease({ ...context.repo, release_id: release.id });
  }
  core.info(`Deleted ${candidates.length} old automated Releases. Kept newest ${KEEP} complete Releases and everything under one month old.`);
}

module.exports = { monthAgo, artifactPlan, releasePlan, completeRelease,
  cleanupArtifacts, cleanupReleases, REQUIRED_ASSETS };
