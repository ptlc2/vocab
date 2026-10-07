import { complete as mistral } from './mistral.js';
import { complete as openai } from './openai.js';
import { complete as fireworks } from './fireworks.js';

export function complete(input) {
    const explicit = process.env.LLM_PROVIDER;
    const provider = explicit || (process.env.MISTRAL_API_KEY ? 'mistral' : 'openai');
    if (provider === 'mistral') {
        return mistral(input);
    } else if (provider === 'fireworks') {
        return fireworks(input);
    } else {
        return openai(input);
    }
}
