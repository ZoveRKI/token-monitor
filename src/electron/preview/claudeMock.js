'use strict';

// Development transport, injected only by the explicitly isolated mock preview.
// These are public fixture keys, never credentials. No branch performs I/O.
const CLAUDE_MOCK_SCENARIOS = [
  { key: 'sk-ant-preview-user1', label: '多个 Team', plans: [
    { id: 'team-design', name: 'Design Studio', plan: 'team', session: 21, weekly: 37 },
    { id: 'team-research', name: 'Research Lab', plan: 'team', session: 68, weekly: 75 }
  ] },
  { key: 'sk-ant-preview-user2', label: '个人 Pro + Team', plans: [
    { id: 'personal', name: 'Personal', plan: 'pro', session: 35, weekly: 62 },
    { id: 'team-company', name: 'Company', plan: 'team', session: 10, weekly: 24 }
  ] },
  { key: 'sk-ant-preview-user3', label: '个人 Max + 多个 Team', plans: [
    { id: 'personal', name: 'Personal', plan: 'max', session: 12, weekly: 34, fable: 7 },
    { id: 'team-design', name: 'Design Studio', plan: 'team', session: 45, weekly: 67 },
    { id: 'team-research', name: 'Research Lab', plan: 'team', session: 90, weekly: 93 }
  ] },
  { key: 'sk-ant-preview-user4', label: '只有 Free', plans: [] },
  { key: 'sk-ant-preview-user5', label: 'Pro + 一个无权限的 Team', plans: [
    { id: 'personal', name: 'Personal', plan: 'pro', session: 35, weekly: 62 },
    { id: 'team-denied', name: 'Restricted Team', plan: 'team', status: 403 }
  ] },
  { key: 'sk-ant-preview-user6', label: 'Team 暂无额度', plans: [
    { id: 'team-empty', name: 'Empty Team', plan: 'team' }
  ] }
];

function createClaudeMockFetch({ now = Date.now } = {}) {
  const startedAt = now();
  const resetAt = (hours) => new Date(startedAt + hours * 60 * 60 * 1000).toISOString();
  const response = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => structuredClone(body)
  });
  return async (url, init = {}) => {
    init.signal?.throwIfAborted();
    const target = new URL(url);
    if (target.origin !== 'https://claude.ai') throw new Error('Mock preview only accepts Claude fixture requests');
    const cookie = new Headers(init.headers).get('cookie') || '';
    const scenario = CLAUDE_MOCK_SCENARIOS.find((entry) => cookie === `sessionKey=${entry.key}`);
    if (!scenario) return response({ error: 'Unknown preview session key' }, 401);
    const user = scenario.key.replace('sk-ant-preview-', '');
    const plans = [{ id: 'free', name: 'Personal Free', plan: 'free' }, ...scenario.plans];
    const organizations = plans.map((plan) => ({
      uuid: `${user}-${plan.id}`,
      name: plan.name,
      capabilities: ['chat', ...(plan.plan === 'team' ? ['raven']
        : plan.plan === 'free' ? [] : [`claude_${plan.plan}`])],
      ...(plan.plan === 'team' ? { raven_type: 'team' } : {})
    }));
    if (target.pathname === '/api/organizations') return response(organizations);
    if (target.pathname === '/api/account') return response({
      uuid: `preview-account-${user}`,
      email_address: `${user}@preview.example`,
      memberships: organizations.map((organization) => ({ organization, seat_tier: null }))
    });
    const match = target.pathname.match(/^\/api\/organizations\/([^/]+)\/(usage|prepaid\/credits)$/);
    const index = match ? organizations.findIndex((organization) => organization.uuid === decodeURIComponent(match[1])) : -1;
    if (index < 0) return response({ error: 'Unknown preview organization' }, 404);
    const plan = plans[index];
    if (plan.status) return response({ error: 'Preview seat is not accessible' }, plan.status);
    if (match[2] === 'prepaid/credits') return response({});
    const window = (percent, hours) => percent === undefined ? null : { utilization: percent, resets_at: resetAt(hours) };
    return response({
      five_hour: window(plan.session, 3),
      seven_day: window(plan.weekly, 72),
      ...(plan.fable === undefined ? {} : {
        limits: [{ kind: 'weekly_scoped', scope: { model: { display_name: 'Fable' } }, ...window(plan.fable, 72) }]
      })
    });
  };
}

module.exports = { CLAUDE_MOCK_SCENARIOS, createClaudeMockFetch };
