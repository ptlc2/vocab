import { complete } from '../llm/index.js';
import { extractJsonFromLlmOutput } from '../generate.js';
import { queryMany, endPool } from '../database.js';
import { z } from 'zod';

const MAX_VALIDATION_ATTEMPTS = 3;

const ShortDefinitionSchema = z.object({
    short_definition: z.string().min(10),
});

function wordPattern(word) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![\\p{L}])${escaped}(?![\\p{L}])`, 'iu');
}

function buildPrompt(word, forbidden) {
    const forbiddenList = [word.text, ...forbidden].map(text => `« ${text} »`).join(', ');
    return `
Tu es un lexicographe francophone. La définition courte du mot « ${word.text} » (registre ${word.register}, niveau ${word.difficulty}) est défectueuse : elle emploie un mot interdit.

Réécris UNIQUEMENT sa définition courte (une seule phrase, même sens, même registre, même niveau), SANS JAMAIS employer :
- le mot « ${word.text} » lui-même (ni ses variantes) ;
- les mots interdits suivants (ni leurs variantes) : ${forbiddenList}.

Réponds STRICTEMENT un objet JSON : {"short_definition": "la nouvelle définition courte"}
`.trim();
}

async function findShortDefinition(word, forbidden) {
    const prompt = buildPrompt(word, forbidden);
    let lastError;
    for (let attempt = 1; attempt <= MAX_VALIDATION_ATTEMPTS; attempt++) {
        const raw = await complete(prompt);
        try {
            return ShortDefinitionSchema.parse(extractJsonFromLlmOutput(raw)).short_definition;
        } catch (err) {
            lastError = err;
            console.warn(
                `Réponse invalide pour « ${word.text} » (tentative ${attempt}/${MAX_VALIDATION_ATTEMPTS}) : ${err?.message ?? err}`
            );
        }
    }
    throw lastError;
}

try {
    const words = await queryMany(
        'SELECT id, text, difficulty, register, short_definition, long_definition FROM word ORDER BY text'
    );
    const byText = new Map(words.map(word => [word.text, word]));
    const pairs = await queryMany(
        `SELECT w1.text AS a, w2.text AS b FROM confusion c
        JOIN word w1 ON w1.id = c.word1_id
        JOIN word w2 ON w2.id = c.word2_id
        UNION ALL
        SELECT w1.text, w2.text FROM near_words n
        JOIN word w1 ON w1.id = n.word1_id
        JOIN word w2 ON w2.id = n.word2_id`
    );

    const violations = new Map();
    function report(wordText, forbiddenText) {
        const entry = violations.get(wordText) ?? new Set();
        entry.add(forbiddenText);
        violations.set(wordText, entry);
    }

    for (const word of words) {
        if (wordPattern(word.text).test(word.short_definition)) {
            report(word.text, word.text);
        }
    }
    for (const pair of pairs) {
        for (const [x, y] of [
            [pair.a, pair.b],
            [pair.b, pair.a],
        ]) {
            const wx = byText.get(x);
            if (!wx || !byText.has(y)) continue;
            if (wordPattern(y).test(wx.short_definition)) {
                report(x, y);
            }
        }
    }

    console.info(
        `Passe de définitions : ${violations.size} mots à corriger (règle : définition courte sans auto-citation ni citation d'un mot lié).`
    );

    let fixed = 0;
    let stillBroken = 0;
    let failed = 0;

    for (const [wordText, forbiddenSet] of violations) {
        const word = byText.get(wordText);
        const forbidden = [...forbiddenSet].filter(text => text !== wordText);
        let newDefinition;
        try {
            newDefinition = await findShortDefinition(word, forbidden);
        } catch (err) {
            failed += 1;
            console.error(`× ${wordText} : ${err?.message ?? err}`);
            continue;
        }
        const stillCites = [wordText, ...forbidden].some(text => wordPattern(text).test(newDefinition));
        if (stillCites) {
            stillBroken += 1;
            console.warn(`= ${wordText} : la réécriture cite encore un mot interdit, ancienne définition conservée`);
            continue;
        }
        await queryMany('UPDATE word SET short_definition = $1 WHERE id = $2 RETURNING id', [newDefinition, word.id]);
        fixed += 1;
        console.info(`+ ${wordText} : ${newDefinition.slice(0, 80)}`);
    }

    console.info(`Terminé : ${fixed} définitions corrigées, ${stillBroken} toujours fautives (conservées), ${failed} échecs.`);
    if (stillBroken > 0 || failed > 0) process.exitCode = 1;
} catch (err) {
    console.error(`Échec de la passe de définitions : ${err?.message ?? err}`);
    process.exitCode = 1;
} finally {
    await endPool();
}
