import { generateWordsList, generateNewWord, parseLevelSpec } from '../generate.js';
import { findWordId, insertWord, linkWordRelations } from '../vocab.js';
import { endPool } from '../database.js';

const DEFAULT_COUNT = 10;
const MAX_COUNT = 200;
const LANGUAGES = ['fr', 'en'];

function parseArgs(argv) {
    const positional = [];
    let levelValue = null;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--niveau' || arg === '--level') {
            levelValue = argv[i + 1] ?? null;
            i += 1;
        } else if (arg.startsWith('--niveau=') || arg.startsWith('--level=')) {
            levelValue = arg.split('=').slice(1).join('=');
        } else if (arg.startsWith('--')) {
            continue;
        } else {
            positional.push(arg);
        }
    }
    return { positional, levelValue };
}

const { positional, levelValue } = parseArgs(process.argv.slice(2));
const count = Math.max(1, Math.min(MAX_COUNT, Number.parseInt(positional[0], 10) || DEFAULT_COUNT));
const language = LANGUAGES.includes(positional[1]) ? positional[1] : 'fr';
const level = levelValue !== null ? parseLevelSpec(levelValue) : null;
if (levelValue !== null && !level) {
    console.error('Spécification de niveau invalide (formats attendus : 4, 4-5, 4à5) — abandon.');
    process.exit(2);
}
const levelSpec = level ? `${level.min}-${level.max}` : null;
const maxWords = count * 2;

function isSingleWord(text) {
    return /^[a-zà-öø-ÿœæ]+(?:[-'][a-zà-öø-ÿœæ]+)*$/i.test(text);
}

try {
    console.info(`Génération d'une liste de ${count} mots (${language}${levelSpec ? `, niveaux ${levelSpec}` : ''})…`);
    const initial = await generateWordsList(count, language, levelSpec);

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

        if ((await findWordId(text, language)) !== null) {
            alreadyPresent += 1;
            console.info(`= ${text} (déjà en base)`);
            continue;
        }

        try {
            const word = { ...(await generateNewWord(text, language)), language };
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
                    if (!seen.has(confusion.other) && isSingleWord(confusion.other))
                        queue.push({ text: confusion.other, cascade: true });
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
