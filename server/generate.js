import { complete } from './llm/index.js';
import { z } from 'zod';

const MAX_VALIDATION_ATTEMPTS = 3;

export const WordsListSchema = z.array(z.string().min(1)).min(1);

export const ConfusionSchema = z.object({
    other: z.string().min(1),
    nuance: z.string().min(1),
});

export const WordSchema = z.object({
    text: z.string().min(1),
    difficulty: z.preprocess(coerceNumber, z.number().int().min(1).max(5)),
    register: z.preprocess(normalizeRegister, z.enum(['familier', 'courant', 'soutenu', 'litteraire', 'technique'])),
    short_definition: z.string().min(1),
    long_definition: z.string().min(1),
    origin: z.preprocess(normalizeOrigin, z.string().optional().nullable()),
    //notes: z.string().optional().nullable(),
    categories: z.array(z.string().min(1)).default([]),
    examples: z.array(z.string().min(1)).min(1),
    near_words: z.array(z.string().min(1)).default([]),
    confusions: z.array(ConfusionSchema).default([]),
});

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

export async function generateWordsList(count = 10) {
    const prompt = `
Tu es un lexicographe francophone qui prépare une liste de mots pour un jeu d'apprentissage du vocabulaire.

Objectif : proposer ${count} mots français qui soient intéressants à apprendre
(mélange possible entre courant, soutenu, littéraire ou technique), mais sans
inclure de noms propres ni de sigles.

Contraintes de sortie :
- Tu dois renvoyer STRICTEMENT un tableau JSON de chaînes de caractères.
- Format : ["mot1", "mot2", "mot3", ...]
- Le tableau doit contenir exactement ${count} mots.
- Chaque élément doit être un seul mot (pas d'expression, pas de groupe de mots).
- Pas de commentaire, pas de texte avant ou après, pas de clé supplémentaire.

Réponds uniquement avec ce tableau JSON.
`.trim();
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

export async function generateNewWord(wordText) {
    const prompt = `
Tu es un lexicographe francophone qui prépare une base de données pour un jeu vidéo d'apprentissage du vocabulaire.

Pour le mot donné, tu dois produire UN SEUL objet JSON STRICT (l'objet lui-même, PAS un schéma JSON), avec exactement ces clés :
- "text" : le mot lui-même
- "difficulty" : entier de 1 (courant) à 5 (érudit)
- "register" : exactement l'une de "familier", "courant", "soutenu", "litteraire", "technique"
- "short_definition" : définition en une phrase courte
- "long_definition" : définition développée en deux ou trois phrases
- "origin" : origine étymologique (latin, grec, autre langue, etc.) ou null si inconnue
- "categories" : tableau de thèmes ou domaines d'usage (exemples : "culinaire", "marine", "informatique", "littérature", "temps", "émotions", "caractère", "nature", "philosophie", "travail")
- "examples" : tableau de 2 ou 3 phrases d'exemple montrant l'usage du mot (au moins UNE obligatoire)
- "near_words" : tableau de mots proches (synonymes imparfaits, mêmes sphères d'usage), 0 à 4
- "confusions" : tableau de 0 à 2 objets {"other" : mot souvent confondu avec, "nuance" : la différence en une ou deux phrases courtes}. Le mot confondu doit être de niveau de difficulté IDENTIQUE ou PROCHE (au plus 1 d'écart), jamais 2 ou plus.

Exemple de réponse attendue (pour le mot « volubile ») :
{
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
}

Contraintes :
- La langue de travail est le français.
- Réponds UNIQUEMENT avec l'objet JSON pour le mot demandé, sans texte avant ni après, sans bloc de code, sans schéma JSON.

Mot à traiter : "${wordText}"
`.trim();

    let lastError;
    for (let attempt = 1; attempt <= MAX_VALIDATION_ATTEMPTS; attempt++) {
        const raw = await complete(prompt);
        try {
            return WordSchema.parse(extractJsonFromLlmOutput(raw));
        } catch (err) {
            lastError = err;
            console.warn(
                `Réponse invalide pour « ${wordText} » (tentative ${attempt}/${MAX_VALIDATION_ATTEMPTS}) : ${err?.message ?? err}`
            );
        }
    }
    throw lastError;
}
