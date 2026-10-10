/**
 * Project service management Service Definition.
 * @module
 */
import { Context, Service } from '@deepseek-ai/cordis'
import type { ProjectServiceProvider, ServiceAccess, ServiceControlRequest, ServiceControlResult, ServiceFeedFrame, ServiceInventory, ServiceListRequest, ServiceLogPage, ServiceLogsRequest } from './types.ts'
export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { projectServices: ProjectServiceRuntime }
}
/** Shared Host service; providers and consumers use the same authorization and revisions. */
export abstract class ProjectServiceRuntime extends Service {
  constructor(ctx: Context) { super(ctx, 'projectServices') }
  /**
   * Return a fresh read-authorized project snapshot.
   * @param access - Trusted caller.
   * @param request - Paging options.
   * @param signal - Cancellation.
   * @returns Read-filtered inventory.
   */
  abstract list(access: ServiceAccess, request: ServiceListRequest, signal: AbortSignal): Promise<ServiceInventory>
  /**
   * Read retained output without consuming another reader’s position.
   * @param access - Trusted caller.
   * @param request - Independent reader.
   * @param signal - Cancellation.
   * @returns Bounded authorized output.
   */
  abstract logs(access: ServiceAccess, request: ServiceLogsRequest, signal: AbortSignal): Promise<ServiceLogPage>
  /**
   * Authorize and publish one idempotent operation.
   * @param access - Trusted caller.
   * @param request - Idempotent operation.
   * @param signal - Initiator cancellation before publication.
   * @returns Read-filtered operation status.
   */
  abstract control(access: ServiceAccess, request: ServiceControlRequest, signal: AbortSignal): Promise<ServiceControlResult>
  /**
   * Subscribe to fresh baselines and ordered inventory updates.
   * @param access - Trusted caller.
   * @param request - Snapshot options.
   * @param signal - Subscription cancellation.
   * @returns Fresh baseline followed by ordered updates.
   */
  abstract follow(access: ServiceAccess, request: ServiceListRequest, signal: AbortSignal): AsyncIterable<ServiceFeedFrame>
  /**
   * Register one provider until its owning effect is disposed.
   * @param provider - Host contribution.
   * @returns Effect-owned removal.
   */
  abstract registerProvider(provider: ProjectServiceProvider): () => void
}
export default ProjectServiceRuntime
