// All identity, destination and notification handles come from the local environment.
// Do not put personal agent names or private repository identifiers in source.
export function mentionAliases(value = process.env.MENTION_ALIASES || '') {
  const aliases = Object.create(null);
  const reserved = new Set(['start','ping','status','last','threads','open','close','who','cancel','mentions','help','github']);
  for (const entry of String(value).split(',')) {
    if (!entry.trim()) continue;
    const parts = entry.trim().split(':');
    if (parts.length !== 2) throw new Error('Invalid MENTION_ALIASES syntax');
    const alias = parts[0].trim().toLowerCase();
    const handle = parts[1].trim();
    if (!/^[a-z][a-z0-9_]{1,24}$/.test(alias) ||
        !/^[A-Za-z0-9-]{1,39}$/.test(handle) || reserved.has(alias))
      throw new Error('Invalid mention alias/handle');
    aliases[alias] = handle;
  }
  return aliases;
}
export function githubConfig(env = process.env) {
  const repo = env.GITHUB_REPO || '';
  const branch = env.GITHUB_BRANCH || 'main';
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ||
      repo.includes('..') || !/^[A-Za-z0-9._\/-]+$/.test(branch) ||
      branch.includes('..') || branch.startsWith('/'))
    throw new Error('Configure GITHUB_REPO=owner/repository and a safe GITHUB_BRANCH');
  return {repo, branch};
}
