import { generateWordsList, generateNewWord } from '../generate.js';
import { findWordId, insertWord, linkWordRelations } from '../vocab.js';
import { endPool } from '../database.js';

const DEFAULT_COUNT = 10;
const MAX_COUNT = 200;

const count = Math.max(1, Math.min(MAX_COUNT, Number.parseInt(process.argv[2], 10) || DEFAULT_COUNT));
const maxWords = count * 2;

function isSingleWord(text) {
    return /^[a-zà-öø-ÿœæ]+(?:[-'][a-zà-öø-ÿœæ]+)*$/i.test(text);
}

try {
    console.info(`Génération d'une liste de ${count} mots…`);
    const initial = await generateWordsList(count);

    const queue = initial.map(text => ({ text, cascade: false }));
    const seen = new Set();
    const generated = [];
    let created = 0;
    let alreadyPresent = 0;
    let failed = 0;
    let consecutiveFailures = 0;

    while (queue.length > 0 && seen.size < maxWords) {
        const { text, cascade } = queue.shift();
        if (seen.has(text)) continue;
        seen.add(text);

        if ((await findWordId(text)) !== null) {
            alreadyPresent += 1;
            console.info(`= ${text} (déjà en base)`);
            continue;
        }

        try {
            const word = await generateNewWord(text);
            const result = await insertWord(word);
            if (!result.created) {
                alreadyPresent += 1;
            } else {
                created += 1;
                generated.push(word);
                await linkWordRelations(word);
                for (const near of word.near_words) {
                    if (!seen.has(near) && isSingleWord(near)) queue.push({ text: near, cascade: true });
                }
                for (const confusion of word.confusions) {
                    if (!seen.has(confusion.other) && isSingleWord(confusion.other)) queue.push({ text: confusion.other, cascade: true });
                }
            }
            consecutiveFailures = 0;
            console.info(`+ ${word.text} (difficulté ${word.difficulty}${cascade ? ', en cascade' : ''})`);
        } catch (err) {
            failed += 1;
            consecutiveFailures += 1;
            console.error(`× ${text} : ${err?.message ?? err}`);
            if (consecutiveFailures >= 3) {
                console.error('3 échecs consécutifs, abandon.');
                process.exitCode = 1;
                break;
            }
        }
    }

    if (queue.length > 0) {
        console.warn(`Limite de ${maxWords} mots atteinte, ${queue.length} partenaires non explorés.`);
    }

    for (const word of generated) {
        await linkWordRelations(word);
    }

    console.info(`Terminé : ${created} créés, ${alreadyPresent} déjà présents, ${failed} échecs.`);
    if (failed > 0) process.exitCode = 1;
} catch (err) {
    console.error(`Échec de la génération : ${err?.message ?? err}`);
    process.exitCode = 1;
} finally {
    await endPool();
}
