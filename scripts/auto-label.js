const TYPE_LABELS = {
  fix: 'bug',
  bug: 'bug',
  feat: 'enhancement',
  feature: 'enhancement',
  perf: 'enhancement',
  docs: 'documentation',
  documentation: 'documentation',
  question: 'question',
};

export function inferredLabels({ title = '', body = '' }, files = []) {
  const labels = new Set();
  const conventional = title.match(/^([a-z]+)(?:\(([^)]+)\))?!?:\s/i);
  const type = conventional?.[1]?.toLowerCase();
  const scope = conventional?.[2]?.toLowerCase();
  if (Object.hasOwn(TYPE_LABELS, type)) labels.add(TYPE_LABELS[type]);
  else if (
    /^(?:(?:how|why|what|where|when|question)\b|(?:can|does|is)\s)/i.test(title)
  ) {
    labels.add('question');
  } else if (
    /\b(?:bug|regression|steps to reproduce|reproduction|actual behavior)\b/i.test(
      `${title}\n${body}`,
    )
  ) {
    labels.add('bug');
  } else if (/\b(?:feature request|enhancement)\b/i.test(`${title}\n${body}`)) {
    labels.add('enhancement');
  }
  if (type === 'ci') labels.add('github_actions');
  if (scope === 'deps' || scope === 'deps-dev') labels.add('dependencies');
  for (const file of files) {
    if (/^\.github\/(?:workflows|actions)\//.test(file))
      labels.add('github_actions');
    if (
      /(?:^|\/)(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|go\.(?:mod|sum))$/.test(
        file,
      )
    ) {
      labels.add('dependencies');
    }
    if (/\.go$/.test(file) || /(?:^|\/)go\.(?:mod|sum)$/.test(file))
      labels.add('go');
    if (/\.(?:md|rst)$/i.test(file)) labels.add('documentation');
  }
  return [...labels].sort();
}

function itemNumber(value) {
  if (
    !/^[1-9]\d*$/.test(String(value)) ||
    !Number.isSafeInteger(Number(value))
  ) {
    throw new Error('Item number must be a positive safe integer.');
  }
  return Number(value);
}

export async function labelItem({ github, repo, number, availableLabels }) {
  number = itemNumber(number);
  const { data: item } = await github.rest.issues.get({
    ...repo,
    issue_number: number,
  });
  if (item.state !== 'open') return [];
  const files = item.pull_request
    ? (
        await github.paginate(github.rest.pulls.listFiles, {
          ...repo,
          pull_number: number,
          per_page: 100,
        })
      ).flatMap((file) =>
        [file.filename, file.previous_filename].filter(Boolean),
      )
    : [];
  const current = new Set(
    item.labels.map((label) =>
      typeof label === 'string' ? label : label.name,
    ),
  );
  const labels = inferredLabels(item, files).filter(
    (label) => availableLabels.has(label) && !current.has(label),
  );
  if (labels.length) {
    await github.rest.issues.addLabels({
      ...repo,
      issue_number: number,
      labels,
    });
  }
  return labels;
}

export default async function autoLabel({ github, context, core }) {
  const repo = context.repo;
  const manualNumber = context.payload.inputs?.number?.trim();
  const eventNumber =
    context.payload.issue?.number ?? context.payload.pull_request?.number;
  const number = manualNumber ? itemNumber(manualNumber) : eventNumber;
  if (!number && context.eventName !== 'workflow_dispatch') {
    throw new Error('This event does not identify an issue or pull request.');
  }
  const availableLabels = new Set(
    (
      await github.paginate(github.rest.issues.listLabelsForRepo, {
        ...repo,
        per_page: 100,
      })
    )
      .filter((label) => !label.archived_at)
      .map((label) => label.name),
  );
  const numbers = number
    ? [number]
    : (
        await github.paginate(github.rest.issues.listForRepo, {
          ...repo,
          state: 'open',
          per_page: 100,
        })
      ).map((item) => item.number);
  for (const number of numbers) {
    const labels = await labelItem({ github, repo, number, availableLabels });
    core.info(
      `#${number}: ${labels.length ? `added ${labels.join(', ')}` : 'no label changes'}`,
    );
  }
}
