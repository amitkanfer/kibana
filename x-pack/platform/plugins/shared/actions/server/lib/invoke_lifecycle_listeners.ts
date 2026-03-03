/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Logger } from '@kbn/logging';
import type { ConnectorLifecycleListener } from '../types';

export async function invokeLifecycleListeners(
  listeners: ConnectorLifecycleListener[] | undefined,
  hookName: 'onPostSave' | 'onPostDelete',
  connectorType: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: any,
  logger: Logger
): Promise<void> {
  if (!listeners?.length) return;
  for (const listener of listeners) {
    if (listener.connectorTypes === '*' || listener.connectorTypes.includes(connectorType)) {
      const hook = listener[hookName];
      if (hook) {
        try {
          await hook({ ...params, connectorType });
        } catch (err) {
          // Log but don't fail the connector operation for listener errors
          logger.error(
            `Connector lifecycle listener ${hookName} error for connectorType ${connectorType}: ${err.message}`
          );
        }
      }
    }
  }
}
