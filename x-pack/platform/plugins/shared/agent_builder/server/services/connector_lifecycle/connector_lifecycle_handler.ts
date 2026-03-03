/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { promises as fs } from 'fs';
import { join, extname } from 'path';
import type { OpeningAndClosingTags } from 'mustache';
import Mustache from 'mustache';
import { parse } from 'yaml';
import { trimStart } from 'lodash';
import { ToolType } from '@kbn/agent-builder-common';
import type { Logger } from '@kbn/logging';
import type { KibanaRequest } from '@kbn/core/server';
import type { WorkflowYaml } from '@kbn/workflows';
import { getConnectorSpec } from '@kbn/connector-specs';
import type {
  PostSaveConnectorHookParams,
  PostDeleteConnectorHookParams,
} from '@kbn/actions-plugin/server';
import type { WorkflowsServerPluginSetup } from '@kbn/workflows-management-plugin/server';
import type { ServiceManager } from '..';

const TEMPLATE_DELIMITERS: OpeningAndClosingTags = ['<%=', '%>'];
const CONNECTOR_TAG_PREFIX = 'connector:';

// Map connector type IDs to spec directory names within kbn-connector-specs
const SPEC_DIR_MAP: Record<string, string> = {
  '.slack2': 'slack',
  '.github': 'github',
  '.notion': 'notion',
  '.zendesk': 'zendesk',
  '.pagerduty': 'pagerduty',
  '.servicenow_search': 'servicenow_search',
  '.google_drive': 'google_drive',
  '.sharepoint_online': 'sharepoint_online',
  '.jira': 'atlassian/jira-cloud',
};

function getWorkflowsDirectory(connectorTypeId: string): string | undefined {
  const spec = getConnectorSpec(connectorTypeId);
  if (!spec?.agentBuilderWorkflows) return undefined;

  const dirName = SPEC_DIR_MAP[connectorTypeId];
  if (!dirName) return undefined;

  // Resolve relative to kbn-connector-specs package source
  return join(require.resolve('@kbn/connector-specs'), '..', 'src', 'specs', dirName, 'workflows');
}

interface ConnectorLifecycleHandlerDeps {
  serviceManager: ServiceManager;
  workflowsManagement?: WorkflowsServerPluginSetup;
  logger: Logger;
}

async function loadWorkflowYamls(
  directory: string,
  templateInputs: Record<string, string>
): Promise<Array<{ content: string; shouldGenerateABTool: boolean }>> {
  const files = await fs.readdir(directory);
  const yamlFiles = files.filter((file) => {
    const ext = extname(file);
    return ext === '.yaml' || ext === '.yml';
  });

  return Promise.all(
    yamlFiles.map(async (fileName) => {
      const filePath = join(directory, fileName);
      const rawContent = await fs.readFile(filePath, 'utf-8');
      const content = Mustache.render(rawContent, templateInputs, {}, TEMPLATE_DELIMITERS);
      const parsed = parse(content);
      const shouldGenerateABTool = parsed?.tags?.includes('agent-builder-tool') ?? false;
      return { content, shouldGenerateABTool };
    })
  );
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function createConnectorLifecycleHandler(deps: ConnectorLifecycleHandlerDeps) {
  const { serviceManager, workflowsManagement, logger } = deps;

  return {
    async onPostSave(
      params: PostSaveConnectorHookParams & { connectorType: string }
    ): Promise<void> {
      // Only handle new connector creation, not updates
      if (params.isUpdate || !params.wasSuccessful) return;

      const { connectorId, connectorType } = params;
      const workflowsDir = getWorkflowsDirectory(connectorType);
      if (!workflowsDir) return;

      logger.info(
        `Connector lifecycle: creating workflows/tools for connector ${connectorId} (type: ${connectorType})`
      );

      try {
        // Build template substitution map: e.g., { "slack2-stack-connector-id": "abc-123" }
        const connectorTypeKey = trimStart(connectorType, '.');
        const templateInputs: Record<string, string> = {
          [`${connectorTypeKey}-stack-connector-id`]: connectorId,
        };

        const workflowInfos = await loadWorkflowYamls(workflowsDir, templateInputs);

        const internalServices = serviceManager.internalStart;
        if (!internalServices) {
          logger.error('Connector lifecycle: services not started yet, cannot create workflows');
          return;
        }

        if (!workflowsManagement) {
          logger.error('Connector lifecycle: workflow management not available');
          return;
        }

        const request = params.request as KibanaRequest;
        const toolRegistry = await internalServices.tools.getRegistry({ request });
        const connectorTag = `${CONNECTOR_TAG_PREFIX}${connectorId}`;
        const connectorName = slugify(connectorTypeKey);

        for (const workflowInfo of workflowInfos) {
          const parsed: WorkflowYaml = parse(workflowInfo.content);
          const originalName = parsed?.name ?? 'workflow';
          const workflowBaseName = originalName.split('.').pop() || originalName;
          const prefixedName = `connector.${connectorName}.${workflowBaseName}`;

          // Replace the name in the YAML using regex
          const updatedContent = workflowInfo.content.replace(
            /^name:\s*['"]?[^'"\n]+['"]?/m,
            `name: "${prefixedName}"`
          );

          const workflow = await workflowsManagement.management.createWorkflow(
            { yaml: updatedContent },
            'default',
            request
          );

          logger.info(
            `Connector lifecycle: created workflow '${workflow.name}' (id: ${workflow.id})`
          );

          if (workflowInfo.shouldGenerateABTool) {
            const workflowDescription =
              typeof parsed?.description === 'string'
                ? parsed.description
                : `Workflow tool for ${connectorTypeKey} connector`;

            const toolId = `${connectorTypeKey}.${connectorName}.${workflowBaseName}`;
            const tool = await toolRegistry.create({
              id: toolId,
              type: ToolType.workflow,
              description: workflowDescription,
              tags: ['connector', connectorTypeKey, connectorTag],
              configuration: {
                workflow_id: workflow.id,
              },
            });

            logger.info(
              `Connector lifecycle: created tool '${tool.id}' for workflow '${workflow.name}'`
            );
          }
        }
      } catch (error) {
        logger.error(
          `Connector lifecycle: failed to create workflows/tools for connector ${connectorId}: ${error.message}`
        );
      }
    },

    async onPostDelete(
      params: PostDeleteConnectorHookParams & { connectorType: string }
    ): Promise<void> {
      const { connectorId, connectorType } = params;

      logger.info(
        `Connector lifecycle: cleaning up workflows/tools for deleted connector ${connectorId} (type: ${connectorType})`
      );

      try {
        const internalServices = serviceManager.internalStart;
        if (!internalServices) {
          logger.error('Connector lifecycle: services not started yet, cannot clean up');
          return;
        }

        const request = params.request as KibanaRequest;
        const toolRegistry = await internalServices.tools.getRegistry({ request });
        const connectorTag = `${CONNECTOR_TAG_PREFIX}${connectorId}`;

        // Find and delete tools tagged with this connector
        const tools = await toolRegistry.list();
        const connectorTools = tools.filter(
          (tool) => tool.tags && tool.tags.includes(connectorTag)
        );
        for (const tool of connectorTools) {
          await toolRegistry.delete(tool.id);
          logger.info(`Connector lifecycle: deleted tool '${tool.id}'`);
        }

        // Find and delete workflows by looking up workflow IDs from the tool configurations
        if (workflowsManagement) {
          const workflowIds = connectorTools
            .map((tool) => (tool.configuration as Record<string, unknown>)?.workflow_id as string)
            .filter(Boolean);

          if (workflowIds.length > 0) {
            await workflowsManagement.management.deleteWorkflows(workflowIds, 'default', request);
            logger.info(
              `Connector lifecycle: deleted ${workflowIds.length} workflow(s) for connector ${connectorId}`
            );
          }
        }
      } catch (error) {
        logger.error(
          `Connector lifecycle: failed to clean up for connector ${connectorId}: ${error.message}`
        );
      }
    },
  };
}
