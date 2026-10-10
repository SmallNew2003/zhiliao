/**
 * Versioned project service definitions and explicit resource associations.
 * @module
 */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { ServiceAssociation, ServiceCheckoutId, ServiceDefinition, ServiceProjectId, ServiceProviderId, ServiceRevision, ServiceTargetId } from '@deepseek-ai/dsh-project-services'

const targetId = z.string().min(1).transform(value => value as ServiceTargetId)
const projectId = z.string().min(1).transform(value => value as ServiceProjectId)
const checkoutId = z.string().min(1).transform(value => value as ServiceCheckoutId)
const revision = z.string().min(1).transform(value => value as ServiceRevision)
const command = z.object({ argv: z.array(z.string()).min(1).refine(argv => argv[0] !== '', 'Executable must not be empty') })
const definition = z.object({ id: targetId, projectId, checkoutId, name: z.string().min(1), command, revision })
const association = z.object({
  id: targetId, projectId, checkoutId,
  providerId: z.string().min(1).transform(value => value as ServiceProviderId), revision,
})

/** No Session events or live process handles are stored in this domain. */
export const projectServicesDomain = defineDomain({
  name: 'project_services', version: 1,
  tables: {
    definitions: domainTable<ServiceTargetId, ServiceDefinition>(definition),
    associations: domainTable<ServiceTargetId, ServiceAssociation>(association),
  },
})
