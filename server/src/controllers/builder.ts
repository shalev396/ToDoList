import { type RequestHandler } from 'express';

import { describeCatalog } from '../builder/catalog.js';
import { AttributeDefinitions } from '../classes/workspace/index.js';
import { ProviderFields } from '../classes/item/ProviderFields.js';
import { listPersonas } from '../builder/personas.js';
import { listTemplates } from '../builder/templates.js';
import { listViewTemplates } from '../builder/viewTemplates.js';
import type {
  BuilderCatalogResponseData,
  InstantiatePersonaResponseData,
  InstantiateTemplateResponseData,
  ListPersonasResponseData,
  ListTemplatesResponseData,
  ListViewTemplatesResponseData,
  TemplateSharesResponseData,
  ValidateDraftResponseData,
} from '../routes/private/builder.js';
import {
  InstantiateBody,
  InstantiatePersonaBody,
  TemplateSharesBody,
  ValidateBody,
} from '../services/dashboardSchemas.js';
import { Dashboard, Persona } from '../classes/dashboard/index.js';
import { parseOr400, routeParam } from '../utils/validation.js';
import type { WorkspaceRequest } from '../types/express.js';
import { withBuilderErrors } from './builderErrors.js';

/** The fixed catalog plus this workspace's attributes and the provider fields its items carry. */
const catalog: RequestHandler = async (req, res): Promise<void> => {
  const { workspace, user } = req as WorkspaceRequest;
  const data: BuilderCatalogResponseData = describeCatalog({
    attributes: AttributeDefinitions.of(workspace.settings).toJSON(),
    providerFields: await ProviderFields.of(workspace, user.id),
  });
  res.success(data);
};

/** People in the UI: hard-coded text is a warning (agents get mcp mode through MCP). */
const validate: RequestHandler = async (req, res): Promise<void> => {
  const { draft } = parseOr400(ValidateBody, req.body);
  const { workspace } = req as WorkspaceRequest;
  const data: ValidateDraftResponseData = await Dashboard.validateDraft(workspace.id, draft, 'ui');
  res.success(data);
};

const instantiate: RequestHandler = async (req, res): Promise<void> => {
  const body = parseOr400(InstantiateBody, req.body);
  const { caller } = req as WorkspaceRequest;
  const data: InstantiateTemplateResponseData = await Dashboard.instantiate(caller, {
    templateKey: body.templateKey,
    language: body.language ?? 'en',
    scope: body.scope,
    shareIntegrations: body.shareIntegrations,
  });
  res.success(data, 201);
};

const templateShares: RequestHandler = async (req, res): Promise<void> => {
  const { templateKeys } = parseOr400(TemplateSharesBody, req.body);
  const { caller } = req as WorkspaceRequest;
  const data: TemplateSharesResponseData = {
    shares: await Dashboard.templateShares(caller, templateKeys),
  };
  res.success(data);
};

const templates: RequestHandler = (_req, res): void => {
  const data: ListTemplatesResponseData = listTemplates();
  res.success(data);
};

const viewTemplates: RequestHandler = (_req, res): void => {
  const data: ListViewTemplatesResponseData = listViewTemplates();
  res.success(data);
};

const personas: RequestHandler = (_req, res): void => {
  const data: ListPersonasResponseData = listPersonas();
  res.success(data);
};

const instantiatePersonaTemplate: RequestHandler = async (req, res): Promise<void> => {
  const body = parseOr400(InstantiatePersonaBody, req.body);
  const { caller } = req as WorkspaceRequest;
  const data: InstantiatePersonaResponseData = await Persona.instantiate(caller, {
    personaKey: routeParam(req, 'key'),
    language: body.language ?? 'en',
    shareIntegrations: body.shareIntegrations,
  });
  res.success(data, 201);
};

export const BuilderController = {
  catalog,
  validate,
  instantiate: withBuilderErrors(instantiate),
  templateShares: withBuilderErrors(templateShares),
  templates,
  viewTemplates,
  personas,
  instantiatePersona: withBuilderErrors(instantiatePersonaTemplate),
} as const;
