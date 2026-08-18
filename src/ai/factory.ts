import { ViewerError } from '../core/errors.js';
import { AnthropicProvider } from './anthropic.js';
import type { AiProfileConfig } from './config.js';
import { GoogleProvider } from './google.js';
import { OllamaProvider } from './ollama.js';
import { OpenAiProvider } from './openai.js';
import type { AiProvider } from './provider.js';

export function createConfiguredProvider(profile: AiProfileConfig, environment: NodeJS.ProcessEnv = process.env): AiProvider {
  switch (profile.provider) {
    case 'ollama': return new OllamaProvider({ profileId: profile.id, label: profile.label, model: profile.model, origin: `http://127.0.0.1:${profile.ollamaPort}`, maxOutputTokens: profile.maxOutputTokens });
    case 'openai': return new OpenAiProvider({ profileId: profile.id, label: profile.label, model: profile.model, apiKey: environment.OPENAI_API_KEY ?? '', maxOutputTokens: profile.maxOutputTokens });
    case 'anthropic': return new AnthropicProvider({ profileId: profile.id, label: profile.label, model: profile.model, apiKey: environment.ANTHROPIC_API_KEY ?? '', maxOutputTokens: profile.maxOutputTokens });
    case 'google': return new GoogleProvider({ profileId: profile.id, label: profile.label, model: profile.model, apiKey: environment.GEMINI_API_KEY ?? '', maxOutputTokens: profile.maxOutputTokens });
    default: { const unsupported: never = profile; throw new ViewerError('INVALID_ARGUMENT', `Unsupported AI provider: ${String(unsupported)}`); }
  }
}
