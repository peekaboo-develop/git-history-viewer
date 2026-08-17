import type { AiEvidenceSummary, AiExplanation } from '../schema/types.js';

export type AiProviderId = 'ollama';

export interface AiProviderDescriptor {
  profileId: string;
  label: string;
  providerId: AiProviderId;
  model: string;
  locality: 'loopback' | 'remote';
  endpointOrigin: string;
  adapterVersion: string;
  structuredOutput: 'required-native';
  maxInputBytes: number;
  maxOutputTokens: number;
}

export interface AiProvider {
  readonly descriptor: AiProviderDescriptor;
  cacheIdentity(): Promise<string>;
  canonicalRequest(evidence: AiEvidenceSummary, cacheIdentity: string): unknown;
  notice(): string;
  generate(evidence: AiEvidenceSummary): Promise<AiExplanation>;
}
