import { complete as mistral } from './mistral.js';
import { complete as openai } from './openai.js';

export function complete(input) {
    const explicit = process.env.LLM_PROVIDER;
    const provider = explicit || (process.env.MISTRAL_API_KEY ? 'mistral' : 'openai');
    if (provider === 'mistral') {
        return mistral(input);
    } else {
        return openai(input);
    }
}
