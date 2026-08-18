import { ViewerError } from '../core/errors.js';
import type { AiProviderDescriptor } from './provider.js';
import { AiExplanationService, type AiExecution, type AiPreview } from './service.js';
import type { GroundingContext } from '../docs/service.js';
import type { GroundedAiExplanationService, GroundedAiExecution, GroundedAiPreview } from './grounding.js';
import { AiExecutionQueue } from './queue.js';

const OWNER_TTL_MS = 6 * 60 * 1_000;
const MAX_OWNERS = 200;

export interface AiRuntime {
  capabilities(): { enabled: true; profiles: AiProviderDescriptor[]; defaultProfileId: string; policy: string };
  preview(oid: string, profileId?: string | null): Promise<AiPreview>;
  execute(requestId: string): Promise<AiExecution>;
  previewGrounded(oid: string, context: GroundingContext, profileId?: string | null): Promise<GroundedAiPreview>;
  executeGrounded(requestId: string): Promise<GroundedAiExecution>;
}

export class AiServiceRegistry implements AiRuntime {
  private readonly services = new Map<string, AiExplanationService>();
  private readonly groundedServices = new Map<string, GroundedAiExplanationService>();
  private readonly owners = new Map<string, { service: AiExplanationService; expiresAt: number }>();
  private readonly groundedOwners = new Map<string, { service: GroundedAiExplanationService; expiresAt: number }>();

  constructor(services: AiExplanationService[], private readonly defaultProfileId: string) {
    if (services.length === 0) throw new ViewerError('INVALID_ARGUMENT', 'At least one AI profile is required.');
    const queue = new AiExecutionQueue();
    for (const service of services) {
      const id = service.provider.descriptor.profileId;
      if (this.services.has(id)) throw new ViewerError('INVALID_ARGUMENT', `Duplicate AI profile ID: ${id}`);
      service.shareQueue(queue); this.services.set(id, service);
      this.groundedServices.set(id, service.createGroundedService());
    }
    if (!this.services.has(defaultProfileId)) throw new ViewerError('INVALID_ARGUMENT', 'The default AI profile does not exist.');
  }

  capabilities(): { enabled: true; profiles: AiProviderDescriptor[]; defaultProfileId: string; policy: string } {
    return { enabled: true, profiles: [...this.services.values()].map((service) => service.provider.descriptor), defaultProfileId: this.defaultProfileId, policy: 'metadata-only; explicit-preview-and-execute' };
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [id, owner] of this.owners) if (owner.expiresAt < now) this.owners.delete(id);
    for (const [id, owner] of this.groundedOwners) if (owner.expiresAt < now) this.groundedOwners.delete(id);
    while (this.owners.size >= MAX_OWNERS) this.owners.delete(this.owners.keys().next().value as string);
    while (this.groundedOwners.size >= MAX_OWNERS) this.groundedOwners.delete(this.groundedOwners.keys().next().value as string);
  }

  async preview(oid: string, profileId?: string | null): Promise<AiPreview> {
    this.cleanup();
    const id = profileId ?? this.defaultProfileId;
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(id)) throw new ViewerError('INVALID_ARGUMENT', 'AI profile ID is invalid.');
    const service = this.services.get(id);
    if (!service) throw new ViewerError('INVALID_ARGUMENT', 'Unknown AI profile.');
    const result = await service.preview(oid);
    this.owners.set(result.requestId, { service, expiresAt: Date.parse(result.expiresAt) });
    return result;
  }

  async execute(requestId: string): Promise<AiExecution> {
    if (!/^[0-9a-f]{32}$/u.test(requestId)) throw new ViewerError('INVALID_ARGUMENT', 'AI request ID is invalid.');
    this.cleanup();
    const owner = this.owners.get(requestId);
    if (!owner) throw new ViewerError('AI_REQUEST_EXPIRED', 'The AI preview expired or no longer exists.');
    return owner.service.execute(requestId);
  }

  async previewGrounded(oid: string, context: GroundingContext, profileId?: string | null): Promise<GroundedAiPreview> {
    this.cleanup(); const id = profileId ?? this.defaultProfileId;
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(id)) throw new ViewerError('INVALID_ARGUMENT', 'AI profile ID is invalid.');
    const service = this.groundedServices.get(id); if (!service) throw new ViewerError('INVALID_ARGUMENT', 'Unknown AI profile.');
    const result = await service.preview(oid, context); this.groundedOwners.set(result.requestId, { service, expiresAt: Date.parse(result.expiresAt) }); return result;
  }

  async executeGrounded(requestId: string): Promise<GroundedAiExecution> {
    if (!/^[0-9a-f]{32}$/u.test(requestId)) throw new ViewerError('INVALID_ARGUMENT', 'Grounded AI request ID is invalid.');
    this.cleanup(); const owner = this.groundedOwners.get(requestId);
    if (!owner) throw new ViewerError('AI_REQUEST_EXPIRED', 'The grounded AI preview expired or no longer exists.');
    return owner.service.execute(requestId);
  }
}
