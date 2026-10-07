import OpenAI from 'openai';
import { callWithRateLimit } from './retry.js';

const apiKey = process.env.OPENAI_API_KEY;
const client = apiKey ? new OpenAI({ apiKey }) : null;

export async function complete(input) {
    if (!client) {
        throw new Error('OPENAI_API_KEY is not set in environment variables.');
    }
    const response = await callWithRateLimit(() =>
        client.responses.create({
            model: 'gpt-5-nano',
            input,
            store: true,
        })
    );
    return response.output_text;
}
