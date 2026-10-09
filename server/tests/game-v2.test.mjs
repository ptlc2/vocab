// Tests du moteur de jeu Vocab (côté client) — node tests/game-v2.test.mjs, sans dépendance.
import assert from 'node:assert/strict';
import {
    newState,
    storageKey,
    loadState,
    saveState,
    recordRound,
    categoryLevel,
    dueWords,
    counts,
    pickRound,
    isCloseMatch,
    levenshtein,
    blankOutWord,
} from '../static/game.js';

let checks = 0;
function ok(name) {
    checks += 1;
    console.info(`ok ${checks} - ${name}`);
}

// --- newState / storageKey ---------------------------------------------------

assert.deepEqual(newState(), {
    words: {},
    session: { rounds: 0, score: 0, streak: 0, best: 0 },
    bands: {},
    totals: {},
});
ok('newState : forme v2 (words, session, bands, totals)');

assert.equal(storageKey('fr'), 'vocab:progress:v2:fr');
assert.equal(storageKey('en'), 'vocab:progress:v2:en');
ok('storageKey : une clé v2 par langue');

// --- loadState / sanitisation ----------------------------------------------

const memory = new Map();
const storage = {
    getItem: key => memory.get(key) ?? null,
    setItem: (key, value) => void memory.set(key, String(value)),
    removeItem: key => void memory.delete(key),
};

assert.equal(loadState(storage, 'fr').session.rounds, 0);
ok('loadState : vide -> état neuf');

const good = {
    words: { 7: { text: 'brume', difficulty: 2, box: 2, due: 5, correct: 2, wrong: 0, categories: ['nature'] } },
    session: { rounds: 3, score: 2, streak: 1, best: 2 },
    bands: { nature: [1, 2] },
    totals: { nature: 80 },
};
storage.setItem('vocab:progress:v2:fr', JSON.stringify(good));
const loaded = loadState(storage, 'fr');
assert.equal(loaded.words['7'].text, 'brume');
assert.equal(loaded.session.rounds, 3);
assert.deepEqual(loaded.bands.nature, [1, 2]);
assert.equal(loaded.totals.nature, 80);
ok('loadState : aller-retour stable (mots, session, bandes, totaux)');

storage.setItem('vocab:progress:v2:fr', '{pas du json');
assert.equal(loadState(storage, 'fr').session.rounds, 0);
ok('loadState : corrompu -> état neuf');

storage.setItem(
    'vocab:progress:v2:fr',
    JSON.stringify({
        words: {
            undefined: { text: undefined, difficulty: 2 },
            9: { text: 'calme', difficulty: 9, box: 99, due: -5, correct: -1, wrong: 0, categories: ['nature'] },
        },
        session: { rounds: 2 },
        bands: { nature: [0, 3, 9] },
        totals: { nature: -3, autre: 4 },
    })
);
const sanitized = loadState(storage, 'fr');
assert.equal('undefined' in sanitized.words, false);
assert.equal(sanitized.words['9'].difficulty, 5);
assert.equal(sanitized.words['9'].box, 5);
assert.equal(sanitized.words['9'].due, 0);
assert.equal(sanitized.words['9'].correct, 0);
assert.deepEqual(sanitized.bands.nature, [3]);
assert.deepEqual(sanitized.totals, { autre: 4 });
ok('loadState : entrées parasites et champs invalides sanités (box clampée, compteurs, bands 1-5, totaux positifs)');

// --- recordRound ------------------------------------------------------------

const state = newState();
recordRound(state, { targetId: undefined, text: undefined, difficulty: NaN, correct: true });
assert.deepEqual(state.words, {});
assert.equal(state.session.rounds, 0);
ok('recordRound : rounds parasites ignorés sans toucher l’état');

recordRound(state, { targetId: 7, text: 'brume', difficulty: 2, correct: true, categories: ['nature'] });
assert.equal(state.words['7'].box, 1);
assert.equal(state.words['7'].due > Date.now(), true);
assert.deepEqual(state.session, { rounds: 1, score: 1, streak: 1, best: 1 });
assert.deepEqual(state.words['7'].categories, ['nature']);
ok('recordRound : bonne réponse -> boîte 1, catégories enregistrées, session à jour');

recordRound(state, { targetId: 7, text: 'brume', difficulty: 2, correct: true, categories: ['nature'] });
assert.equal(state.words['7'].box, 2);
ok('recordRound : deuxième bonne réponse -> boîte 2');

recordRound(state, { targetId: 7, text: 'brume', difficulty: 2, correct: false, categories: ['nature'] });
assert.equal(state.words['7'].box, 0);
assert.equal(state.session.streak, 0);
assert.equal(state.session.best, 2);
ok('recordRound : mauvaise réponse -> boîte 0, série coupée, record conservé');

// --- acquisitions de bandes --------------------------------------------------

const bandState = newState();
recordRound(bandState, { targetId: 1, text: 'a', difficulty: 2, correct: true, categories: ['nature'] });
recordRound(bandState, { targetId: 2, text: 'b', difficulty: 2, correct: true, categories: ['nature'] });
recordRound(bandState, { targetId: 1, text: 'a', difficulty: 2, correct: true, categories: ['nature'] });
assert.deepEqual(bandState.bands.nature, []);
recordRound(bandState, { targetId: 2, text: 'b', difficulty: 2, correct: true, categories: ['nature'] });
assert.deepEqual(bandState.bands.nature, [2]);
ok('acquisition : deux mots même catégorie même difficulté à boîte >= 2 -> bande acquise au deuxième');

const soloState = newState();
recordRound(soloState, { targetId: 1, text: 'a', difficulty: 2, correct: true, categories: ['nature'] });
recordRound(soloState, { targetId: 1, text: 'a', difficulty: 2, correct: true, categories: ['nature'] });
assert.deepEqual(soloState.bands.nature, []);
ok('acquisition : un seul mot, même à boîte 5 -> rien');

const oneSolid = newState();
recordRound(oneSolid, { targetId: 1, text: 'a', difficulty: 2, correct: true, categories: ['nature'] });
recordRound(oneSolid, { targetId: 1, text: 'a', difficulty: 2, correct: true, categories: ['nature'] });
recordRound(oneSolid, { targetId: 2, text: 'b', difficulty: 2, correct: true, categories: ['nature'] });
assert.deepEqual(oneSolid.bands.nature, []);
ok('acquisition : deux mots mais un seul à boîte >= 2 -> rien');

const mixedDifficulty = newState();
for (const [id, difficulty] of [
    ['1', 2],
    ['2', 2],
    ['3', 3],
    ['4', 3],
]) {
    recordRound(mixedDifficulty, { targetId: id, text: id, difficulty, correct: true, categories: ['nature'] });
    recordRound(mixedDifficulty, { targetId: id, text: id, difficulty, correct: true, categories: ['nature'] });
}
assert.deepEqual(mixedDifficulty.bands.nature, [2, 3]);
ok('acquisition : difficultés différentes -> bandes distinctes');

recordRound(mixedDifficulty, { targetId: '1', text: '1', difficulty: 2, correct: false, categories: ['nature'] });
assert.deepEqual(mixedDifficulty.bands.nature, [2, 3]);
ok('acquisition : définitive, pas de régression quand un mot retombe à la boîte 0');

const multiCat = newState();
for (const [id, cat] of [
    ['1', 'nature'],
    ['2', 'nature'],
    ['1', 'couleurs'],
    ['2', 'couleurs'],
]) {
    recordRound(multiCat, { targetId: id, text: id, difficulty: 1, correct: true, categories: [cat] });
    recordRound(multiCat, { targetId: id, text: id, difficulty: 1, correct: true, categories: [cat] });
}
assert.deepEqual(multiCat.bands.nature, [1]);
assert.deepEqual(multiCat.bands.couleurs, [1]);
ok('acquisition : un mot multi-catégories acquiert dans chacune');

assert.equal(categoryLevel(multiCat, 'nature'), 1);
assert.equal(categoryLevel(mixedDifficulty, 'nature'), 3);
assert.equal(categoryLevel(multiCat, 'inconnue'), 1);
ok('categoryLevel : plus haute bande, 1 par défaut');

// --- dueWords / counts --------------------------------------------------------

const dueState = newState();
recordRound(dueState, { targetId: 1, text: 'a', difficulty: 2, correct: false, categories: [] });
recordRound(dueState, { targetId: 2, text: 'b', difficulty: 2, correct: false, categories: [] });
recordRound(dueState, { targetId: 3, text: 'c', difficulty: 2, correct: true, categories: [] });
const dueNow = Date.now() + 11 * 60e3; // les ratés repassent à 10 min, les réussis à 8 h
const due = dueWords(dueState, dueNow);
assert.deepEqual(due.map(word => word.id).sort(), ['1', '2']);
ok('dueWords : ratés dus à 10 min inclus, réussis à 8 h exclus');

const mastered = newState();
recordRound(mastered, { targetId: 1, text: 'a', difficulty: 2, correct: true, categories: [] });
recordRound(mastered, { targetId: 1, text: 'a', difficulty: 2, correct: true, categories: [] });
recordRound(mastered, { targetId: 1, text: 'a', difficulty: 2, correct: true, categories: [] });
recordRound(mastered, { targetId: 1, text: 'a', difficulty: 2, correct: true, categories: [] });
const masteredCounts = counts(mastered, Date.now() + 11 * 60e3);
assert.equal(masteredCounts.mastered, 1);
assert.equal(masteredCounts.learning, 0);
ok('counts : boîte 4 -> maîtrisé');

// --- isCloseMatch / blankOutWord ----------------------------------------------

assert.equal(isCloseMatch('brume', 'brume'), true);
assert.equal(isCloseMatch('Brume ', 'brume'), true);
assert.equal(isCloseMatch('brumes', 'brume'), true);
assert.equal(isCloseMatch('brume', 'brumes'), true);
assert.equal(isCloseMatch('brume', 'brumes vivantes'), false);
assert.equal(isCloseMatch('éphémère', 'ephemere'), true);
assert.equal(isCloseMatch('calme', 'colère'), false);
ok('isCloseMatch : casse/accents/1 faute tolérés, 2 fautes ou autre mot rejetés');

assert.equal(levenshtein('chat', 'chats'), 1);
assert.equal(levenshtein('', 'abc'), 3);
ok('levenshtein : base saine');

assert.equal(blankOutWord('La brume du matin', 'brume'), 'La ______ du matin');
assert.equal(blankOutWord('La brume du matin', 'brume', true), 'La b____ du matin');
ok('blankOutWord : blanc simple et blanc avec indice (première lettre + longueur)');

// --- pickRound (le tirage) -----------------------------------------------------

const dictionary = {
    language: 'fr',
    words: [
        {
            id: 1,
            text: 'brume',
            difficulty: 2,
            register: 'courant',
            short_definition: 'Voile d’eau près du sol.',
            long_definition: 'Voile d’eau en suspension près du sol.',
            origin: null,
            notes: null,
            categories: ['nature'],
            examples: ['La brume couvrait la vallée.'],
            distractors: [2, 3, 4],
        },
        {
            id: 2,
            text: 'sillage',
            difficulty: 2,
            register: 'soutenu',
            short_definition: 'Trace laissée derrière un bateau.',
            long_definition: 'Trace que laisse un bateau sur l’eau.',
            origin: null,
            notes: null,
            categories: ['nature'],
            examples: ['Le sillage du navire s’effaçait.'],
            distractors: [1, 3, 4],
        },
        {
            id: 3,
            text: 'sarcasme',
            difficulty: 4,
            register: 'soutenu',
            short_definition: 'Raillerie mordante et méprisante.',
            long_definition: 'Raillerie blessante et méprisante.',
            origin: null,
            notes: null,
            categories: ['caractère'],
            examples: ['Son sarcasme blessait.'],
            distractors: [1, 2, 4],
        },
        {
            id: 4,
            text: 'calme',
            difficulty: 1,
            register: 'courant',
            short_definition: 'Qui est sans agitation.',
            long_definition: 'État de tranquillité.',
            origin: null,
            notes: null,
            categories: ['nature'],
            examples: ['La mer était calme.'],
            distractors: [1, 2, 3],
        },
    ],
    confusions: [
        {
            a_id: 1,
            a_text: 'brume',
            a_def: 'Voile d’eau près du sol.',
            a_difficulty: 2,
            b_id: 4,
            b_text: 'calme',
            b_def: 'Qui est sans agitation.',
            b_difficulty: 1,
            nuance: 'Brume est météo, calme est état.',
        },
    ],
    near_words: [],
};

// état neuf : identification ou contexte seulement (pas de mots solides)
const freshState = newState();
const freshMode = pickRound(dictionary, freshState, {}).mode;
assert.equal(['identification', 'contexte'].includes(freshMode), true);
ok('pickRound : état neuf -> identification ou contexte, jamais frappe/reverse/jumelage');

// avec mots dus : identification sur le mot dû (la mémoire d’abord)
const dueRoundState = newState();
recordRound(dueRoundState, { targetId: 2, text: 'sillage', difficulty: 2, correct: false, categories: ['nature'] });
dueRoundState.words['2'].due = 1; // échoué il y a plus de 10 minutes -> dû
const dueRound = pickRound(dictionary, dueRoundState, {});
assert.equal(dueRound.mode, 'identification');
assert.equal(dueRound.target, 2);
ok('pickRound : mot dû -> identification sur ce mot (mémoire d’abord)');

// avec des solides boîte >= 3 : frappe devient éligible et cible un solide
const typingState = newState();
for (const id of [1, 2]) {
    for (let i = 0; i < 3; i++) {
        recordRound(typingState, {
            targetId: id,
            text: dictionary.words.find(w => w.id === id).text,
            difficulty: 2,
            correct: true,
            categories: ['nature'],
        });
    }
}
const typingModes = new Set();
for (let i = 0; i < 40; i++) {
    typingModes.add(pickRound(dictionary, typingState, {}).mode);
}
assert.equal(typingModes.has('frappe'), true);
const frappeRound = [...Array(20)]
    .map(() => pickRound(dictionary, typingState, { mode: 'frappe' }))
    .find(r => r.mode === 'frappe');
assert.equal([1, 2].includes(frappeRound.target), true);
assert.equal(frappeRound.prompt, dictionary.words.find(w => w.id === frappeRound.target).short_definition);
ok('pickRound : solides boîte >= 3 -> frappe éligible, cible un solide, sa définition en prompt');

// mode explicite : gardé et servi tel quel
const explicitState = newState();
const explicitRound = pickRound(dictionary, explicitState, { mode: 'identification' });
assert.equal(explicitRound.mode, 'identification');
assert.equal(explicitRound.options.length, 4);
assert.equal(new Set(explicitRound.options.map(o => o.id)).size, 4);
ok('pickRound : mode explicite identification -> 4 options distinctes');

const reverseRound = pickRound(dictionary, typingState, { mode: 'reverse' });
assert.equal(reverseRound.mode, 'reverse');
assert.equal(reverseRound.prompt, dictionary.words.find(w => w.id === reverseRound.target).text);
ok('pickRound : mode explicite reverse -> le mot en prompt, définitions en options');

// mot précis demandé
const wordRound = pickRound(dictionary, explicitState, { wordId: 3, mode: 'identification' });
assert.equal(wordRound.target, 3);
ok('pickRound : mot précis -> servi tel quel');

// mot périmé : purge + tirage normal
const staleState = newState();
staleState.words['999'] = { text: 'fantôme', difficulty: 2, box: 2, due: 0, correct: 2, wrong: 0, categories: ['nature'] };
const staleRound = pickRound(dictionary, staleState, { wordId: 999, mode: 'identification' });
assert.equal('999' in staleState.words, false);
assert.equal(['identification', 'contexte'].includes(staleRound.mode), true);
ok('pickRound : id périmé -> purge de la save + tirage normal');

// session de catégorie : la cible vient de la catégorie (les distracteurs restent langue entière)
const categoryState = newState();
let sawIdentificationInCategory = false;
for (let i = 0; i < 20; i++) {
    const round = pickRound(dictionary, categoryState, { category: 'nature' });
    if (round.mode === 'identification') {
        assert.equal([1, 2, 4].includes(round.target), true);
        sawIdentificationInCategory = true;
        break;
    }
}
assert.equal(sawIdentificationInCategory, true);
ok('pickRound : session de catégorie -> cible dans la catégorie');

// piste : tirage dans la famille
const trackState = typingState;
const trackModes = new Set();
for (let i = 0; i < 30; i++) {
    trackModes.add(pickRound(dictionary, trackState, { track: 'acquisition' }).mode);
}
assert.equal(
    [...trackModes].every(mode => ['identification', 'reverse', 'frappe'].includes(mode)),
    true
);
assert.equal(trackModes.size > 1, true);
ok('pickRound : piste acquisition -> tirage dans la famille (identification/reverse/frappe)');

// jumelage : cible le mot solide de la paire
const jumelageRound = pickRound(dictionary, typingState, { mode: 'jumelage' });
assert.equal(jumelageRound.mode, 'jumelage');
assert.equal(jumelageRound.options.length, 2);
assert.equal([1, 4].includes(jumelageRound.target), true);
assert.equal(typeof jumelageRound.nuance, 'string');
ok('pickRound : jumelage -> paire avec nuance, cible le solide de la paire');

// contexte : phrase à trous
const contexteRound = pickRound(dictionary, typingState, { mode: 'contexte' });
assert.equal(contexteRound.mode, 'contexte');
assert.equal(contexteRound.prompt.includes('______'), true);
assert.equal(contexteRound.options.length, 2);
ok('pickRound : contexte -> phrase à trous, 2 options');

console.info(`\nTests unitaires v2 : ${checks} vérifications ok`);
