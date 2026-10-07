import OpenAI from 'openai';
import { callWithRateLimit } from './retry.js';

const apiKey = process.env.FIREWORKS_API_KEY;
const client = apiKey
    ? new OpenAI({
          apiKey,
          baseURL: 'https://api.fireworks.ai/inference/v1',
      })
    : null;
const model = process.env.FIREWORKS_MODEL || 'accounts/fireworks/models/glm-5p3';

export async function complete(input) {
    if (!client) {
        throw new Error('FIREWORKS_API_KEY is not set in environment variables.');
    }
    const response = await callWithRateLimit(() =>
        client.chat.completions.create({
            model,
            messages: [{ role: 'user', content: input }],
        })
    );
    return response.choices[0].message.content;
}
