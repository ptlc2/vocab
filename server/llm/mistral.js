import { Mistral } from '@mistralai/mistralai';
import { callWithRateLimit } from './retry.js';

const apiKey = process.env.MISTRAL_API_KEY;
const client = apiKey ? new Mistral({ apiKey }) : null;

export async function complete(input) {
    if (!client) {
        throw new Error('MISTRAL_API_KEY is not set in environment variables.');
    }
    const chatResponse = await callWithRateLimit(() =>
        client.chat.complete({
            model: 'mistral-large-latest',
            messages: [{ role: 'user', content: input }],
        })
    );
    return chatResponse.choices[0].message.content;
}
