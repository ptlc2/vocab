import { complete } from '../llm/index.js';
import { extractJsonFromLlmOutput } from '../generate.js';
import { queryMany, endPool } from '../database.js';
import { linkConfusion, findWordId } from '../vocab.js';
import { z } from 'zod';

const CHUNK_SIZE = 25;
const MAX_VALIDATION_ATTEMPTS = 3;

const PairsSchema = z
    .array(
        z.object({
            word1: z.string().min(1),
            word2: z.string().min(1),
            nuance: z.string().min(1),
        })
    )
    .max(20);

function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

function buildPrompt(words) {
    const list = words.map(word => `- ${word.text} (niveau ${word.difficulty}) : ${word.short_definition}`).join('\n');
    return `
Tu es un lexicographe francophone chargé d'enrichir un jeu de vocabulaire.

Voici une liste de mots français (mot, niveau de difficulté 1-5, définition courte) :
${list}

Identifie les PAIRES de mots de CETTE liste qui sont réellement et couramment CONFONDUS
entre eux : sens que l'on mélange, emploi trompeur, proximité trompeuse.
Pas de simples synonymes, pas des mots simplement liés par le même sujet.

Règles strictes :
- Uniquement les confusions réelles et courantes. En cas de doute, ne l'inclus pas.
- Les deux mots doivent être de niveau identique ou à ±1 près.
- Maximum 3 paires par mot, et pas plus d'une dizaine de paires au total pour la liste.
- "nuance" : la différence entre les deux mots en une ou deux phrases courtes et claires.
- Si aucune confusion justifiée n'existe dans la liste, renvoie [].

Réponds STRICTEMENT un tableau JSON :
[{"word1": "premier mot", "word2": "second mot", "nuance": "la différence"}]
`.trim();
}

async function findPairs(words) {
    const prompt = buildPrompt(words);
    let lastError;
    for (let attempt = 1; attempt <= MAX_VALIDATION_ATTEMPTS; attempt++) {
        const raw = await complete(prompt);
        try {
            return PairsSchema.parse(extractJsonFromLlmOutput(raw));
        } catch (err) {
            lastError = err;
            console.warn(`Paires invalides (tentative ${attempt}/${MAX_VALIDATION_ATTEMPTS}) : ${err?.message ?? err}`);
        }
    }
    throw lastError;
}

try {
    const words = await queryMany('SELECT id, text, difficulty, short_definition FROM word ORDER BY difficulty, text');
    const chunks = [];
    const shuffled = shuffle([...words]);
    for (let i = 0; i < shuffled.length; i += CHUNK_SIZE) {
        chunks.push(shuffled.slice(i, i + CHUNK_SIZE));
    }
    console.info(`Passe de nuances : ${words.length} mots en ${chunks.length} lots de ${CHUNK_SIZE}.`);

    let created = 0;
    let alreadyThere = 0;
    let rejected = 0;
    let unknown = 0;
    let failedChunks = 0;

    for (const [index, chunk] of chunks.entries()) {
        let pairs;
        try {
            pairs = await findPairs(chunk);
        } catch (err) {
            console.error(`× lot ${index + 1}/${chunks.length} : ${err?.message ?? err}`);
            failedChunks += 1;
            continue;
        }
        for (const pair of pairs) {
            if (pair.word1.toLowerCase() === pair.word2.toLowerCase()) {
                rejected += 1;
                continue;
            }
            const id1 = await findWordId(pair.word1);
            const id2 = await findWordId(pair.word2);
            if (id1 === null || id2 === null) {
                unknown += 1;
                console.warn(`  ? mot inconnu : « ${id1 === null ? pair.word1 : pair.word2} »`);
                continue;
            }
            const linked = await linkConfusion(id1, id2, pair.nuance);
            if (linked) {
                created += 1;
                console.info(`  + ${pair.word1} × ${pair.word2}`);
            } else {
                alreadyThere += 1;
            }
        }
        console.info(`Lot ${index + 1}/${chunks.length} fait (${pairs.length} paires proposées).`);
    }

    console.info(
        `Terminé : ${created} nuances créées, ${alreadyThere} déjà présentes ou hors règle ±1, ${unknown} mots inconnus, ${failedChunks} lots échoués.`
    );
    if (failedChunks > 0) process.exitCode = 1;
} catch (err) {
    console.error(`Échec de la passe de nuances : ${err?.message ?? err}`);
    process.exitCode = 1;
} finally {
    await endPool();
}
