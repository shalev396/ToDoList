import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import i18next from 'i18next';
import { CONNECTABLE_PROVIDERS } from '@api-types/integrations.ts';
import { PLAN_LIMITS } from '@api-types/limits.ts';
import { en } from '../i18n/translations/en/index.ts';
import { he } from '../i18n/translations/he/index.ts';
import { limits, todosPerWorkspace } from './limits.ts';
import { joinList, planFeatures, supportedIntegrations } from './pricing.ts';

/** Every string under a translation subtree, flattened. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (value !== null && typeof value === 'object') {
    return Object.values(value).flatMap(strings);
  }
  return [];
}

describe('the pricing page reads the shared limits', () => {
  it('reads every number from the one source the server enforces', () => {
    assert.equal(limits.workspacesCreatedPerUser, PLAN_LIMITS.workspacesCreatedPerUser);
    assert.equal(limits.membersPerWorkspace, PLAN_LIMITS.membersPerWorkspace);
    assert.equal(
      limits.integrationsPerUserPerWorkspace,
      PLAN_LIMITS.integrationsPerUserPerWorkspace,
    );
    assert.equal(limits.integrationsPerWorkspace, PLAN_LIMITS.integrationsPerWorkspace);
    assert.equal(limits.agentKeysPerUser, PLAN_LIMITS.agentKeysPerUser);
    assert.equal(limits.manualSyncIntervalMinutes * 60_000, PLAN_LIMITS.manualSyncIntervalMs);
    assert.equal(limits.blocksPerPage, PLAN_LIMITS.blocksPerPage);
    assert.equal(limits.viewsPerPage, PLAN_LIMITS.viewsPerPage);
    assert.equal(limits.attributesPerWorkspace, PLAN_LIMITS.attributesPerWorkspace);
    assert.equal(todosPerWorkspace, PLAN_LIMITS.todosPerWorkspace);
  });

  it('names every integration the server can connect now, work tools first; Moodle waits', () => {
    assert.deepEqual(
      [...supportedIntegrations].sort(),
      CONNECTABLE_PROVIDERS.filter((provider) => provider !== 'moodle').sort(),
    );
    assert.deepEqual(supportedIntegrations, [
      'jira',
      'clickup',
      'linear',
      'google_calendar',
      'github',
    ]);
  });

  it('lists the plan in the agreed order', () => {
    assert.deepEqual(
      planFeatures.map((feature) => feature.id),
      [
        'integrations',
        'agents',
        'todos',
        'workspaces',
        'blocks',
        'views',
        'attributes',
        'templates',
      ],
    );
  });

  it('keeps no numbers in the plan strings', () => {
    for (const lang of [en, he]) {
      for (const text of strings(lang.pricing.plan)) {
        assert.doesNotMatch(text, /\d/, text);
      }
    }
  });
});

describe('the plan as each language reads it', () => {
  const i18n = i18next.createInstance();

  before(async () => {
    await i18n.init({
      resources: { en: { translation: en }, he: { translation: he } },
      lng: 'en',
      interpolation: { escapeValue: false },
    });
  });

  for (const lng of ['en', 'he'] as const) {
    it(`fills every line with its number and no placeholder is left (${lng})`, () => {
      const t = i18n.getFixedT(lng);
      for (const { id, title, detail } of planFeatures) {
        for (const copy of detail ? [title, detail] : [title]) {
          const text = t(copy.key, { ...copy.values, list: 'LIST' });
          assert.notEqual(text, copy.key, `${id}: missing ${copy.key}`);
          assert.doesNotMatch(text, /\{\{/, `${id}: ${text}`);
          const count = copy.values?.['count'];
          if (count !== undefined) {
            assert.match(text, new RegExp(`(^|\\D)${String(count)}(\\D|$)`), `${id}: ${text}`);
          }
        }
      }
    });
  }

  it('says the plan has no feature limits and unlimited to-dos (en)', () => {
    const t = i18n.getFixedT('en');
    assert.equal(t('pricing.plan.period'), 'no feature limits');
    const todos = planFeatures.find((feature) => feature.id === 'todos');
    assert.ok(todos);
    assert.equal(t(todos.title.key, { ...todos.title.values }), 'Unlimited to-dos');
    const workspaces = planFeatures.find((feature) => feature.id === 'workspaces');
    assert.ok(workspaces);
    assert.equal(
      t(workspaces.title.key, { ...workspaces.title.values }),
      `Up to ${String(limits.workspacesCreatedPerUser)} workspaces`,
    );
  });

  it('joins the integration names in each language', () => {
    const names = ['Jira', 'ClickUp', 'Moodle'];
    const en = i18n.getFixedT('en');
    assert.equal(
      joinList(names, en('pricing.plan.list.separator'), en('pricing.plan.list.last')),
      'Jira, ClickUp and Moodle',
    );
    const he = i18n.getFixedT('he');
    assert.equal(
      joinList(names, he('pricing.plan.list.separator'), he('pricing.plan.list.last')),
      'Jira,‏ ClickUp ו-⁠Moodle',
    );
    assert.equal(joinList(['Jira'], ', ', ' and '), 'Jira');
    assert.equal(joinList([], ', ', ' and '), '');
  });
});
