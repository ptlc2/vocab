import { complete } from './llm/index.js';
import { z } from 'zod';

const MAX_VALIDATION_ATTEMPTS = 3;

export const REGISTERS = {
    fr: ['familier', 'courant', 'soutenu', 'litteraire', 'technique'],
    en: ['informal', 'standard', 'formal', 'literary', 'technical'],
};

export const WordsListSchema = z.array(z.string().min(1)).min(1);

export const ConfusionSchema = z.object({
    other: z.string().min(1),
    nuance: z.string().min(1),
});

export function buildWordSchema(language = 'fr') {
    return z.object({
        text: z.string().min(1),
        difficulty: z.preprocess(coerceNumber, z.number().int().min(1).max(5)),
        register: z.preprocess(normalizeRegister, z.enum(REGISTERS[language] ?? REGISTERS.fr)),
        short_definition: z.string().min(1),
        long_definition: z.string().min(1),
        origin: z.preprocess(normalizeOrigin, z.string().optional().nullable()),
        //notes: z.string().optional().nullable(),
        categories: z.array(z.string().min(1)).default([]),
        examples: z.array(z.string().min(1)).min(1),
        near_words: z.array(z.string().min(1)).default([]),
        confusions: z.array(ConfusionSchema).default([]),
    });
}

export const WordSchema = buildWordSchema('fr');

function coerceNumber(value) {
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
        return Number(value);
    }
    return value;
}

function normalizeRegister(value) {
    if (typeof value !== 'string') return value;
    return value
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z]/g, '');
}

function normalizeOrigin(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return value.trim() === '' ? null : value.trim();
    if (typeof value === 'object' && !Array.isArray(value)) {
        const text = Object.values(value)
            .filter(part => typeof part === 'string')
            .join(' ')
            .trim();
        return text === '' ? null : text;
    }
    return value;
}

export function extractJsonFromLlmOutput(raw) {
    const candidates = [];
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) candidates.push(fenced[1]);
    candidates.push(raw);
    candidates.push(...topLevelJsonCandidates(raw));
    for (const text of candidates) {
        try {
            return JSON.parse(text.trim());
        } catch {
            continue;
        }
    }
    throw new Error(
        `Impossible de parser la réponse du LLM comme du JSON.
      Réponse brute (début) : ${raw.slice(0, 500)}`
    );
}

function topLevelJsonCandidates(text) {
    const candidates = [];
    let start = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') {
            inString = true;
        } else if (ch === '{' || ch === '[') {
            if (depth === 0) start = i;
            depth++;
        } else if (ch === '}' || ch === ']') {
            if (depth > 0) {
                depth--;
                if (depth === 0 && start >= 0) {
                    candidates.push(text.slice(start, i + 1));
                }
            }
        }
    }
    return candidates.reverse();
}

export function parseLevelSpec(spec) {
    if (spec === null || spec === undefined) return null;
    const match = String(spec)
        .trim()
        .match(/^([1-5])(?:\s*[-àa]\s*([1-5]))?$/);
    if (!match) return null;
    const min = Number.parseInt(match[1], 10);
    const max = match[2] === undefined ? min : Number.parseInt(match[2], 10);
    if (min > max) return null;
    return { min, max };
}

function levelLineFr(level) {
    if (!level) return '';
    const cible =
        level.min === level.max
            ? `de niveau de difficulté ${level.min} sur 5`
            : `de niveau de difficulté ${level.min} à ${level.max} sur 5`;
    return `Cible de difficulté OBLIGATOIRE : uniquement des mots ${cible}
(pas de mot courant si la cible est 4 ou plus).`;
}

function levelLineEn(level) {
    if (!level) return '';
    const target =
        level.min === level.max
            ? `of difficulty level ${level.min} out of 5`
            : `of difficulty level ${level.min} to ${level.max} out of 5`;
    return `MANDATORY difficulty target: only words ${target}
(no everyday words if the target is 4 or higher).`;
}

function listPromptFr(count, level) {
    return `
Tu es un lexicographe francophone qui prépare une liste de mots pour un jeu d'apprentissage du vocabulaire.

Objectif : proposer ${count} mots français qui soient intéressants à apprendre
(mélange possible entre courant, soutenu, littéraire ou technique), mais sans
inclure de noms propres ni de sigles.
${levelLineFr(level)}

Contraintes de sortie :
- Tu dois renvoyer STRICTEMENT un tableau JSON de chaînes de caractères.
- Format : ["mot1", "mot2", "mot3", ...]
- Le tableau doit contenir exactement ${count} mots.
- Chaque élément doit être un seul mot (pas d'expression, pas de groupe de mots).
- Pas de commentaire, pas de texte avant ou après, pas de clé supplémentaire.

Réponds uniquement avec ce tableau JSON.
`.trim();
}

function listPromptEn(count, level) {
    return `
You are an English lexicographer preparing a word list for a vocabulary-learning game.

Goal: propose ${count} English words that are interesting to learn
(a mix of everyday, formal, literary or technical words), without proper nouns or acronyms.
${levelLineEn(level)}

Output constraints:
- Return STRICTLY a JSON array of strings.
- Format: ["word1", "word2", "word3", ...]
- The array must contain exactly ${count} words.
- Each entry must be a single word (no expressions, no word groups).
- No commentary, no text before or after, no extra keys.

Respond with the JSON array only.
`.trim();
}

export async function generateWordsList(count = 10, language = 'fr', levelSpec = null) {
    const level = parseLevelSpec(levelSpec);
    const prompt = language === 'en' ? listPromptEn(count, level) : listPromptFr(count, level);
    let lastError;
    for (let attempt = 1; attempt <= MAX_VALIDATION_ATTEMPTS; attempt++) {
        const raw = await complete(prompt);
        try {
            return WordsListSchema.parse(extractJsonFromLlmOutput(raw));
        } catch (err) {
            lastError = err;
            console.warn(`Liste de mots invalide (tentative ${attempt}/${MAX_VALIDATION_ATTEMPTS}) : ${err?.message ?? err}`);
        }
    }
    throw lastError;
}

function wordPromptFr(wordText, registers, jsonSchemaExample) {
    return `
Tu es un lexicographe francophone qui prépare une base de données pour un jeu vidéo d'apprentissage du vocabulaire.

Pour le mot donné, tu dois produire UN SEUL objet JSON STRICT (l'objet lui-même, PAS un schéma JSON), avec exactement ces clés :
- "text" : le mot lui-même
- "difficulty" : entier de 1 (courant) à 5 (érudit)
- "register" : exactement l'une de ${JSON.stringify(registers)}
- "short_definition" : définition en une phrase courte — elle ne doit JAMAIS employer le mot lui-même, ni un de ses mots proches ou confondables (ni leurs variantes)
- "long_definition" : définition développée en deux ou trois phrases
- "origin" : origine étymologique (latin, grec, autre langue, etc.) ou null si inconnue
- "categories" : tableau de thèmes ou domaines d'usage (exemples : "culinaire", "marine", "informatique", "littérature", "temps", "émotions", "caractère", "nature", "philosophie", "travail")
- "examples" : tableau de 2 ou 3 phrases d'exemple montrant l'usage du mot (au moins UNE obligatoire)
- "near_words" : tableau de mots proches (synonymes imparfaits, mêmes sphères d'usage), 0 à 4
- "confusions" : tableau de 0 à 2 objets {"other" : mot souvent confondu avec, "nuance" : la différence en une ou deux phrases courtes}. Le mot confondu doit être de niveau de difficulté IDENTIQUE ou PROCHE (au plus 1 d'écart), jamais 2 ou plus.

Exemple de réponse attendue (pour le mot « volubile ») :
${jsonSchemaExample}

Contraintes :
- La langue de travail est le français.
- Réponds UNIQUEMENT avec l'objet JSON pour le mot demandé, sans texte avant ni après, sans bloc de code, sans schéma JSON.

Mot à traiter : "${wordText}"
`.trim();
}

function wordPromptEn(wordText, registers, jsonSchemaExample) {
    return `
You are an English lexicographer preparing a database for a vocabulary-learning game.

For the given word, produce ONE STRICT JSON object (the object itself, NOT a JSON schema), with exactly these keys:
- "text": the word itself
- "difficulty": integer from 1 (everyday) to 5 (erudite)
- "register": exactly one of ${JSON.stringify(registers)}
- "short_definition": a one-sentence definition — it must NEVER use the word itself, nor any of its near or confusable words (nor their variants)
- "long_definition": a two or three sentence definition
- "origin": etymological origin (Latin, Greek, other language, etc.) or null if unknown
- "categories": array of themes or usage domains (examples: "cooking", "nautical", "computing", "literature", "time", "emotions", "character", "nature", "philosophy", "work")
- "examples": array of 2 or 3 example sentences showing the word in use (at least ONE required)
- "near_words": array of near words (imperfect synonyms, same usage spheres), 0 to 4
- "confusions": array of 0 to 2 objects {"other": a word it is often confused with, "nuance": the difference in one or two short sentences}. The confusable word must be of IDENTICAL or CLOSE difficulty (at most 1 apart), never 2 or more.

Example of the expected answer (for the word "voluble"):
${jsonSchemaExample}

Constraints:
- The working language is English.
- Respond ONLY with the JSON object for the given word, no text before or after, no code block, no JSON schema.

Word to describe: "${wordText}"
`.trim();
}

const EXAMPLE_FR = `{
  "text": "volubile",
  "difficulty": 4,
  "register": "soutenu",
  "short_definition": "Qui parle avec aisance et rapidité.",
  "long_definition": "Se dit d'une personne dont la parole s'écoule avec aisance et vivacité, parfois au point d'être difficile à interrompre.",
  "origin": "latin (volubilis)",
  "categories": ["parole", "caractère"],
  "examples": ["Elle s'exprimait d'un ton volubile, presque intarissable."],
  "near_words": ["bavard", "prolixe"],
  "confusions": [
    {"other": "prolixe", "nuance": "Volubile insiste sur la fluidité de la parole, prolixe sur son excès et sa longueur."}
  ]
}`;

const EXAMPLE_EN = `{
  "text": "voluble",
  "difficulty": 4,
  "register": "formal",
  "short_definition": "Speaking with fluent ease and rapidity.",
  "long_definition": "Said of a person whose speech flows with lively ease, sometimes to the point of being hard to interrupt.",
  "origin": "Latin (volubilis)",
  "categories": ["speech", "character"],
  "examples": ["She chatted on in a voluble stream, almost unstoppable."],
  "near_words": ["talkative", "glib"],
  "confusions": [
    {"other": "glib", "nuance": "Voluble describes fluent, lively speech, while glib adds a note of shallow smoothness."}
  ]
}`;

export async function generateNewWord(wordText, language = 'fr') {
    const registers = REGISTERS[language] ?? REGISTERS.fr;
    const prompt =
        language === 'en' ? wordPromptEn(wordText, registers, EXAMPLE_EN) : wordPromptFr(wordText, registers, EXAMPLE_FR);

    let lastError;
    for (let attempt = 1; attempt <= MAX_VALIDATION_ATTEMPTS; attempt++) {
        const raw = await complete(prompt);
        try {
            return buildWordSchema(language).parse(extractJsonFromLlmOutput(raw));
        } catch (err) {
            lastError = err;
            console.warn(
                `Réponse invalide pour « ${wordText} » (tentative ${attempt}/${MAX_VALIDATION_ATTEMPTS}) : ${err?.message ?? err}`
            );
        }
    }
    throw lastError;
}
