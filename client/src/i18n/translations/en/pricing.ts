/**
 * The pricing page. Every number on it comes from the shared limits (data/limits.ts, read from
 * server/src/types/limits.ts) through {{count}}, so none is written here.
 */
export const pricing = {
  meta: {
    title: 'Pricing',
    description:
      'TodoList is free for individuals, with no feature limits: every integration, MCP access for AI agents, unlimited to-dos, templates and sharing. No paid tiers, no trial, no card.',
  },
  title: 'One plan, and it’s free',
  lead: 'TodoList is free for students, classmates and anyone else. No paid tiers, no trial, no card.',
  plan: {
    name: 'Individual',
    price: 'Free',
    period: 'no feature limits',
    description: 'Everything TodoList does, for you and the people you share with.',
    cta: 'Create your workspace',
    includedTitle: 'What’s included',
    included: {
      integrations: {
        title_one: '{{count}} integration',
        title_other: 'All {{count}} integrations',
        detail_one: '{{list}}, with up to {{count}} connection of your own in each workspace',
        detail_other: '{{list}}, with up to {{count}} connections of your own in each workspace',
      },
      agents: {
        title: 'MCP access for AI agents',
        detail_one: 'Up to {{count}} agent key, revocable at any time',
        detail_other: 'Up to {{count}} agent keys, each revocable at any time',
      },
      todos: {
        unlimited: 'Unlimited to-dos',
        limited_one: 'Up to {{count}} to-do per workspace',
        limited_other: 'Up to {{count}} to-dos per workspace',
        detail: 'Yours, next to everything your tools send in',
      },
      workspaces: {
        title_one: '{{count}} workspace',
        title_other: 'Up to {{count}} workspaces',
        detail_one: 'Each shared with up to {{count}} member',
        detail_other: 'Each shared with up to {{count}} members',
      },
      blocks: {
        title_one: '{{count}} block per page',
        title_other: '{{count}} blocks per page',
        detail: 'Clock, calendar, deadlines, boards, lists, charts and more',
      },
      attributes: {
        title_one: '{{count}} custom attribute per workspace',
        title_other: '{{count}} custom attributes per workspace',
        detail:
          'Importance, effort or anything you track, kept in TodoList and never written to your tools',
      },
      views: {
        title_one: '{{count}} view per page',
        title_other: '{{count}} views per page',
        detail: 'One page, seen as a summary, a list, a board and more',
      },
      templates: {
        title: 'Template views and blocks',
        detail: 'Start any page from a ready-made layout',
      },
    },
    /** Joins the integration names: "A, B and C". */
    list: {
      separator: ', ',
      last: ' and ',
    },
  },
  business: {
    title: 'Business or school?',
    body: 'Tell us what your team or class needs and we’ll get back to you.',
    cta: 'Contact us',
  },
};
