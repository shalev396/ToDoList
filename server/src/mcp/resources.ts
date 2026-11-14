/**
 * MCP resources (MCP.md §10, URIs as `todolist://…`, plan D2): read-only JSON, cached privately
 * for a short time. Each read is checked like a tool call (scopes, role, endpoint), runs through
 * the same services and redaction as the tools, passes the secret guard, and is audited as
 * `mcp.resource.<name>`. A principal is offered only the resources it may read.
 */
import {
  ResourceNotFoundError,
  ResourceTemplate,
  type ListResourcesResult,
  type McpServer,
  type ReadResourceResult,
} from '@modelcontextprotocol/server';

import { describeCatalog } from '../builder/catalog.js';
import { listTemplates, localizeTemplate, resolveTemplateKey } from '../builder/templates.js';
import { AppError } from '../errors/AppError.js';
import { getDashboard, listDashboards, listDashboardVersions } from '../services/dashboards.js';
import type { AgentScope, Role } from '../types/domain.js';
import { canCall } from './auth/scopes.js';
import { blockSecrets } from './middleware/redact.js';
import { recordToolCall } from './middleware/audit.js';
import { INTERNAL_ERROR_MESSAGE } from './pipeline.js';
import type { AuditTarget, ToolContext } from './tool.js';
import { integrationsList } from './tools/integrations/integrationsList.js';
import { getItem } from './tools/read/getItem.js';
import { listFacets } from './tools/read/listFacets.js';
import { workspaceGet } from './tools/workspace/workspaceGet.js';

const JSON_TYPE = 'application/json';
/** Data a member reads: cached by this client only, briefly. */
const LIVE = { cacheScope: 'private', ttlMs: 30_000 } as const;
/** Schemas and templates change with a deploy only. */
const STATIC = { cacheScope: 'private', ttlMs: 300_000 } as const;

type Variables = Record<string, string | string[]>;

interface ResourceRead {
  value: unknown;
  target?: AuditTarget;
}

interface Listed {
  uri: string;
  name: string;
}

interface ResourceDef {
  name: string;
  title: string;
  description: string;
  /** A fixed URI, or an RFC 6570 template. */
  uri: string;
  template: boolean;
  scopes: readonly AgentScope[];
  minRole: Role;
  cache: typeof LIVE | typeof STATIC;
  read: (ctx: ToolContext, uri: URL, variables: Variables) => Promise<ResourceRead>;
  /** Templates: the concrete resources resources/list shows. */
  list?: (ctx: ToolContext) => Promise<Listed[]>;
}

/** A path variable. The SDK's matcher leaves a query string on the last one: it is cut off here. */
function variable(variables: Variables, name: string): string {
  const value = variables[name];
  return ((Array.isArray(value) ? value[0] : value) ?? '').split('?')[0] ?? '';
}

function actorOf(ctx: ToolContext): { userId: string; agentId: string } {
  return { userId: ctx.principal.userId, agentId: ctx.principal.agentId };
}

const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown;

export const RESOURCES: readonly ResourceDef[] = [
  {
    name: 'workspace_current',
    title: 'Current workspace',
    description:
      'The workspace and its settings, the member this key acts for, and this key’s scopes, as workspace_get answers it.',
    uri: 'todolist://workspace/current',
    template: false,
    scopes: ['workspace:read'],
    minRole: 'viewer',
    cache: LIVE,
    async read(ctx): Promise<ResourceRead> {
      return { value: (await workspaceGet.handler(ctx, {})).output };
    },
  },
  {
    name: 'dashboard',
    title: 'Dashboard',
    description:
      'A dashboard’s config: the published copy, or with ?draft=1 the draft (editors). As builder_get_dashboard answers it.',
    uri: 'todolist://dashboard/{id}',
    template: true,
    scopes: ['read'],
    minRole: 'viewer',
    cache: LIVE,
    async read(ctx, uri, variables): Promise<ResourceRead> {
      const view = await getDashboard(ctx.workspace, actorOf(ctx), variable(variables, 'id'), {
        as: uri.searchParams.get('draft') === '1' ? 'draft' : 'published',
      });
      return { value: plain(view), target: { type: 'dashboard', id: view.id } };
    },
    async list(ctx): Promise<Listed[]> {
      const dashboards = await listDashboards(ctx.workspace, actorOf(ctx), {});
      return dashboards.map((dashboard) => ({
        uri: `todolist://dashboard/${dashboard.id}`,
        name: dashboard.title,
      }));
    },
  },
  {
    name: 'dashboard_versions',
    title: 'Dashboard versions',
    description: 'A dashboard’s history, newest first, as builder_list_versions answers it.',
    uri: 'todolist://dashboard/{id}/versions',
    template: true,
    scopes: ['read'],
    minRole: 'editor',
    cache: LIVE,
    async read(ctx, _uri, variables): Promise<ResourceRead> {
      const id = variable(variables, 'id');
      const versions = await listDashboardVersions(ctx.workspace, actorOf(ctx), id, {});
      return { value: { versions: plain(versions) }, target: { type: 'dashboard', id } };
    },
  },
  {
    name: 'item',
    title: 'Item',
    description: 'One item, with its source and its Open in link, as get_item answers it.',
    uri: 'todolist://item/{id}',
    template: true,
    scopes: ['read'],
    minRole: 'viewer',
    cache: LIVE,
    async read(ctx, _uri, variables): Promise<ResourceRead> {
      const { output, target } = await getItem.handler(ctx, { id: variable(variables, 'id') });
      return target === undefined ? { value: output } : { value: output, target };
    },
  },
  {
    name: 'facets',
    title: 'Facets',
    description:
      'The providers, containers (courses, projects), topics and kinds there are items of.',
    uri: 'todolist://facets',
    template: false,
    scopes: ['read'],
    minRole: 'viewer',
    cache: LIVE,
    async read(ctx): Promise<ResourceRead> {
      return { value: (await listFacets.handler(ctx, {})).output };
    },
  },
  {
    name: 'block_schema',
    title: 'Block type schema',
    description:
      'One block type: the viz kinds it allows, whether it needs a query, its defaults and size, and the JSON Schemas of its viz and of a block.',
    uri: 'todolist://schema/block/{type}',
    template: true,
    scopes: ['read'],
    minRole: 'viewer',
    cache: STATIC,
    read(_ctx, uri, variables): Promise<ResourceRead> {
      const catalog = describeCatalog();
      const type = catalog.blockTypes.find((entry) => entry.type === variable(variables, 'type'));
      if (type === undefined) return Promise.reject(new ResourceNotFoundError(uri.href));
      return Promise.resolve({
        value: plain({
          ...type,
          blockSchema: catalog.schemas.block,
          newBlockSchema: catalog.schemas.newBlock,
        }),
      });
    },
    list(): Promise<Listed[]> {
      return Promise.resolve(
        describeCatalog().blockTypes.map(({ type }) => ({
          uri: `todolist://schema/block/${type}`,
          name: `${type} block`,
        })),
      );
    },
  },
  {
    name: 'query_schema',
    title: 'Query schema',
    description:
      'The JSON Schema of a block query, with the fields, operators, date presets, dynamic values and aggregates it may use, and the caps.',
    uri: 'todolist://schema/query',
    template: false,
    scopes: ['read'],
    minRole: 'viewer',
    cache: STATIC,
    read(): Promise<ResourceRead> {
      const catalog = describeCatalog();
      return Promise.resolve({
        value: plain({
          query: catalog.schemas.query,
          fields: catalog.fields,
          operators: catalog.operators,
          datePresets: catalog.datePresets,
          dynamicValues: catalog.dynamicValues,
          aggregateOps: catalog.aggregateOps,
          caps: catalog.caps,
        }),
      });
    },
  },
  {
    name: 'template',
    title: 'Template',
    description:
      'A dashboard template as data (?lang=he for Hebrew titles), as builder_create_dashboard and builder_apply_template use it.',
    uri: 'todolist://templates/{id}',
    template: true,
    scopes: ['read'],
    minRole: 'viewer',
    cache: STATIC,
    read(_ctx, uri, variables): Promise<ResourceRead> {
      const key = resolveTemplateKey(variable(variables, 'id'));
      const draft =
        key === null
          ? null
          : localizeTemplate(key, uri.searchParams.get('lang') === 'he' ? 'he' : 'en');
      if (key === null || draft === null) {
        return Promise.reject(new ResourceNotFoundError(uri.href));
      }
      return Promise.resolve({ value: plain({ key, draft }) });
    },
    list(): Promise<Listed[]> {
      return Promise.resolve(
        listTemplates().map((template) => ({
          uri: `todolist://templates/${template.key}`,
          name: template.titles.en,
        })),
      );
    },
  },
  {
    name: 'integrations_status',
    title: 'Integrations status',
    description: 'The connected providers: status metadata only, as integrations_list answers it.',
    uri: 'todolist://integrations/status',
    template: false,
    scopes: ['integrations:read'],
    minRole: 'viewer',
    cache: LIVE,
    async read(ctx): Promise<ResourceRead> {
      return { value: (await integrationsList.handler(ctx, {})).output };
    },
  },
];

/** The resources a principal may read on this endpoint (all are read-only). */
export function resourcesFor(ctx: ToolContext): ResourceDef[] {
  return RESOURCES.filter((resource) =>
    canCall({ scopes: resource.scopes, minRole: resource.minRole, readOnly: true }, ctx.principal, {
      readonly: ctx.readonly,
    }),
  );
}

/** One read: the services' errors as MCP errors, the guard, the audit entry. */
async function readResource(
  resource: ResourceDef,
  ctx: ToolContext,
  uri: URL,
  variables: Variables,
): Promise<ReadResourceResult> {
  const audited = `resource.${resource.name}`;
  let read: ResourceRead;
  try {
    read = await resource.read(ctx, uri, variables);
  } catch (error) {
    await recordToolCall(ctx.principal, audited, { uri: uri.href }, 'error');
    if (error instanceof AppError && error.statusCode === 404) {
      throw new ResourceNotFoundError(uri.href);
    }
    if (error instanceof AppError && error.statusCode < 500) throw new Error(error.message);
    throw error;
  }
  const result: ReadResourceResult = {
    contents: [{ uri: uri.href, mimeType: JSON_TYPE, text: JSON.stringify(read.value) }],
  };
  let blocked: boolean;
  try {
    blocked = blockSecrets(result, `the MCP resource ${resource.name}`);
  } catch (error) {
    await recordToolCall(ctx.principal, audited, { uri: uri.href }, 'blocked');
    throw error;
  }
  if (blocked) {
    await recordToolCall(ctx.principal, audited, { uri: uri.href }, 'blocked');
    throw new Error(INTERNAL_ERROR_MESSAGE);
  }
  await recordToolCall(ctx.principal, audited, { uri: uri.href }, 'ok', read.target);
  return result;
}

export function registerResources(server: McpServer, ctx: ToolContext): void {
  for (const resource of resourcesFor(ctx)) {
    const metadata = {
      title: resource.title,
      description: resource.description,
      mimeType: JSON_TYPE,
      cacheHint: resource.cache,
    };
    if (!resource.template) {
      server.registerResource(resource.name, resource.uri, metadata, (uri) =>
        readResource(resource, ctx, uri, {}),
      );
      continue;
    }
    const { list } = resource;
    const template = new ResourceTemplate(resource.uri, {
      list:
        list === undefined
          ? undefined
          : async (): Promise<ListResourcesResult> => ({
              resources: (await list(ctx)).map((entry) => ({ ...entry, mimeType: JSON_TYPE })),
            }),
    });
    server.registerResource(resource.name, template, metadata, (uri, variables) =>
      readResource(resource, ctx, uri, variables),
    );
  }
}
