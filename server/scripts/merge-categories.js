import { complete } from '../llm/index.js';
import { extractJsonFromLlmOutput } from '../generate.js';
import { queryMany, queryOne, endPool, withTransaction } from '../database.js';
import { z } from 'zod';

const MAX_VALIDATION_ATTEMPTS = 3;

const MergesSchema = z
    .array(
        z.object({
            from: z.string().min(1),
            to: z.string().min(1),
        })
    )
    .max(60);

function buildPrompt(categories) {
    const list = categories.map(category => `- ${category.name} : ${category.word_count} mot(s)`).join('\n');
    return `
Tu es un lexicographe francophone. Voici les catégories thématiques d'une base de mots (nom : nombre de mots) :
${list}

Certaines de ces catégories devraient être FUSIONNÉES : doublons évidents, singulier/pluriel d'une même notion,
ou variantes proches du même concept (par exemple « corps humain » absorbé par « corps » si les deux existent).

Règles strictes :
- UNIQUEMENT les fusions évidentes et conservatrices — en cas de doute, ne fusionne pas.
- Toujours fusionner VERS la catégorie la mieux nommée ou la plus large.
- Ne fusionne PAS des notions distinctes simplement parce qu'elles sont liées (par exemple « biologie » et
  « médecine » restent distinctes, « émotions » et « caractère » restent distinctes).
- S'il n'y a aucune fusion évidente, renvoie [].

Réponds STRICTEMENT un tableau JSON : [{"from": "catégorie absorbée", "to": "catégorie conservée"}]
`.trim();
}

async function findMerges(categories) {
    const prompt = buildPrompt(categories);
    let lastError;
    for (let attempt = 1; attempt <= MAX_VALIDATION_ATTEMPTS; attempt++) {
        const raw = await complete(prompt);
        try {
            return MergesSchema.parse(extractJsonFromLlmOutput(raw));
        } catch (err) {
            lastError = err;
            console.warn(`Fusions invalides (tentative ${attempt}/${MAX_VALIDATION_ATTEMPTS}) : ${err?.message ?? err}`);
        }
    }
    throw lastError;
}

try {
    const categories = await queryMany(
        `SELECT c.id, c.name, count(wc.word_id)::int AS word_count
        FROM category c
        LEFT JOIN word_category wc ON wc.category_id = c.id
        GROUP BY c.id, c.name
        ORDER BY count(wc.word_id) DESC, c.name ASC`
    );
    console.info(`Passe de fusion : ${categories.length} catégories.`);

    let merges;
    try {
        merges = await findMerges(categories);
    } catch (err) {
        console.error(`× propositions de fusion échouées : ${err?.message ?? err}`);
        process.exitCode = 1;
    }

    if (!merges) {
        throw new Error('no merges');
    }

    let applied = 0;
    let skipped = 0;
    for (const merge of merges) {
        if (merge.from === merge.to) {
            skipped += 1;
            continue;
        }
        const source = await queryOne('SELECT id FROM category WHERE name = $1', [merge.from]);
        const target = await queryOne('SELECT id FROM category WHERE name = $1', [merge.to]);
        if (!source || !target || source.id === target.id) {
            skipped += 1;
            console.warn(`  ? ${merge.from} → ${merge.to} : catégorie inconnue ou identique`);
            continue;
        }
        const moved = await withTransaction(async client => {
            const inserted = await client.query(
                `INSERT INTO word_category (word_id, category_id)
                SELECT wc.word_id, $1 FROM word_category wc WHERE wc.category_id = $2
                ON CONFLICT DO NOTHING
                RETURNING word_id`,
                [target.id, source.id]
            );
            await client.query('DELETE FROM word_category WHERE category_id = $1', [source.id]);
            await client.query(
                'DELETE FROM category WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM word_category WHERE category_id = $1)',
                [source.id]
            );
            return inserted.rows.length;
        });
        applied += 1;
        console.info(`  + ${merge.from} absorbée par ${merge.to} (${moved} réassignations)`);
    }

    console.info(`Terminé : ${applied} fusions appliquées, ${skipped} ignorées.`);
} catch (err) {
    if (err?.message !== 'no merges') {
        console.error(`Échec de la passe de fusion : ${err?.message ?? err}`);
        process.exitCode = 1;
    }
} finally {
    await endPool();
}
