import assert from 'node:assert/strict';
import { test } from 'node:test';
import autoLabel, { inferredLabels, labelItem } from '../scripts/auto-label.js';

test('classification recognizes conventional titles and explicit issue reports', () => {
  for (const [title, expected] of [
    ['fix(cli): preserve profiles', ['bug']],
    ['feat!: add a harness', ['enhancement']],
    ['docs: explain setup', ['documentation']],
    ['ci: configure a bot', ['github_actions']],
    ['chore(deps): update Node', ['dependencies']],
    ['How do I fix this bug?', ['question']],
    ['Unclear request', []],
    ['constructor: unknown title', []],
  ])
    assert.deepEqual(inferredLabels({ title }), expected);
  assert.deepEqual(
    inferredLabels({
      title: 'Profile changes disappear',
      body: 'Steps to reproduce: switch profile and save.',
    }),
    ['bug'],
  );
  assert.deepEqual(
    inferredLabels({ title: "Can't launch", body: 'Reproduction: run subc.' }),
    ['bug'],
  );
  assert.deepEqual(
    inferredLabels({
      title: 'New harness',
      body: 'Feature request: support a new harness.',
    }),
    ['enhancement'],
  );
});

test('opened events and manual item selection label only the requested item', async () => {
  for (const [eventName, payload] of [
    ['issues', { issue: { number: 1 } }],
    ['pull_request_target', { pull_request: { number: 1 } }],
    ['workflow_dispatch', { inputs: { number: ' 1 ' } }],
  ]) {
    const { github, writes, calls } = fakeGithub([
      { number: 1, state: 'open', title: 'fix: broken behavior', labels: [] },
      { number: 2, state: 'open', title: 'feat: new behavior', labels: [] },
    ]);
    await autoLabel({
      github,
      context: { repo: { owner: 'owner', repo: 'repo' }, eventName, payload },
      core: { info: () => {} },
    });
    assert.deepEqual(
      writes.map((write) => write.issue_number),
      [1],
    );
    assert.equal(
      calls.some((call) => call.method === 'items'),
      false,
    );
  }
});

test('PR file labels cover workflow, dependencies, Go and documentation paths', () => {
  assert.deepEqual(
    inferredLabels({ title: 'fix(tui): retain settings' }, [
      '.github/workflows/ci.yml',
      'package-lock.json',
      'tui/go.mod',
      'tui/cmd/main.go',
      'README.md',
    ]),
    ['bug', 'dependencies', 'documentation', 'github_actions', 'go'],
  );
});

function fakeGithub(items) {
  const writes = [];
  const calls = [];
  const methods = {
    get: 'get',
    addLabels: 'addLabels',
    listLabelsForRepo: 'labels',
    listForRepo: 'items',
    listFiles: 'files',
  };
  const github = {
    rest: {
      issues: {
        ...methods,
        get: async ({ issue_number }) => ({
          data: items.find((item) => item.number === issue_number),
        }),
        addLabels: async (request) => {
          writes.push(request);
          items
            .find((item) => item.number === request.issue_number)
            .labels.push(...request.labels);
        },
      },
      pulls: { listFiles: methods.listFiles },
    },
    paginate: async (method, request) => {
      calls.push({ method, request });
      if (method === methods.listLabelsForRepo)
        return [
          'bug',
          'enhancement',
          'documentation',
          'github_actions',
          'go',
        ].map((name) => ({ name }));
      if (method === methods.listForRepo)
        return items.filter((item) => item.state === 'open');
      if (method === methods.listFiles)
        return [
          { filename: 'tui/new.txt', previous_filename: 'tui/main.go' },
          { filename: 'README.md' },
        ];
      throw new Error('Unexpected pagination method');
    },
  };
  return { github, writes, calls };
}

test('labeling preserves manual labels, filters absent labels and is idempotent', async () => {
  const { github, writes } = fakeGithub([
    {
      number: 1,
      state: 'open',
      title: 'fix: correct behavior',
      body: '',
      labels: [{ name: 'help wanted' }],
      pull_request: {},
    },
  ]);
  const options = {
    github,
    repo: { owner: 'owner', repo: 'repo' },
    number: 1,
    availableLabels: new Set(['bug', 'go']),
  };
  assert.deepEqual(await labelItem(options), ['bug', 'go']);
  assert.deepEqual(await labelItem(options), []);
  assert.deepEqual(writes, [
    { owner: 'owner', repo: 'repo', issue_number: 1, labels: ['bug', 'go'] },
  ]);
});

test('closed items are skipped and invalid numbers cannot call the API', async () => {
  const { github, writes, calls } = fakeGithub([
    { number: 2, state: 'closed', title: 'fix: old', labels: [] },
  ]);
  const options = {
    github,
    repo: { owner: 'owner', repo: 'repo' },
    availableLabels: new Set(['bug']),
  };
  assert.deepEqual(await labelItem({ ...options, number: 2 }), []);
  for (const number of ['-1', '0', '1;rm', '1.5', '9007199254740992']) {
    await assert.rejects(
      labelItem({ ...options, number }),
      /positive safe integer/,
    );
  }
  assert.deepEqual(writes, []);
  assert.deepEqual(calls, []);
});

test('manual backfill covers open issues and PRs through paginated API methods', async () => {
  const { github, writes, calls } = fakeGithub([
    {
      number: 1,
      state: 'open',
      title: 'Bug: missing key',
      body: '',
      labels: [],
    },
    {
      number: 2,
      state: 'open',
      title: 'feat: new UI',
      body: '',
      labels: [],
      pull_request: {},
    },
    { number: 3, state: 'closed', title: 'fix: old', body: '', labels: [] },
  ]);
  await autoLabel({
    github,
    context: {
      repo: { owner: 'owner', repo: 'repo' },
      eventName: 'workflow_dispatch',
      payload: { inputs: { number: '' } },
    },
    core: { info: () => {} },
  });
  assert.deepEqual(
    writes.map((write) => write.issue_number),
    [1, 2],
  );
  assert.ok(
    calls.some(
      (call) =>
        call.method === 'items' &&
        call.request.state === 'open' &&
        call.request.per_page === 100,
    ),
  );
  assert.ok(
    calls.some(
      (call) =>
        call.method === 'files' &&
        call.request.pull_number === 2 &&
        call.request.per_page === 100,
    ),
  );
});

test('archived repository labels are not applied', async () => {
  const { github, writes } = fakeGithub([
    { number: 1, state: 'open', title: 'fix: broken', labels: [] },
  ]);
  github.paginate = async () => [
    { name: 'bug', archived_at: '2026-10-04T00:00:00Z' },
  ];
  await autoLabel({
    github,
    context: {
      repo: { owner: 'owner', repo: 'repo' },
      eventName: 'issues',
      payload: { issue: { number: 1 } },
    },
    core: { info: () => {} },
  });
  assert.deepEqual(writes, []);
});
