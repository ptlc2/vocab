// Tests du modèle de progression v2 (localStorage côté client) — node tests/game-v2.test.mjs, sans dépendance.
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
    buildReplayHref,
    poolCookieValue,
} from '../static/game.js';

let checks = 0;
function ok(name) {
    checks += 1;
    console.info(`ok ${checks} - ${name}`);
}

function storageWith(data) {
    const items = new Map(Object.entries(data));
    return {
        getItem: key => (items.has(key) ? items.get(key) : null),
        setItem: (key, value) => items.set(key, String(value)),
        removeItem: key => items.delete(key),
    };
}

// --- newState / storageKey -------------------------------------------------

assert.deepEqual(newState(), {
    words: {},
    session: { rounds: 0, score: 0, streak: 0, best: 0 },
    bands: {},
    totals: {},
});
ok('newState : forme v2 (words, session sans palier, bands, totals)');

assert.equal(storageKey('fr'), 'vocab:progress:v2:fr');
assert.equal(storageKey('en'), 'vocab:progress:v2:en');
ok('storageKey : une clé v2 par langue');

// --- loadState / sanitisation ----------------------------------------------

assert.deepEqual(loadState(null, 'fr'), newState());
assert.deepEqual(loadState(storageWith({}), 'fr'), newState());
ok('loadState : stockage absent ou vide -> état neuf');

const brokenStorage = storageWith({ 'vocab:progress:v2:fr': '{pas du json' });
assert.deepEqual(loadState(brokenStorage, 'fr'), newState());
ok('loadState : JSON invalide -> état neuf');

const dirtyStorage = storageWith({
    'vocab:progress:v2:fr': JSON.stringify({
        words: {
            undefined: { text: 'fantôme', difficulty: 2 },
            12: { text: '', difficulty: 2 },
            13: { text: 'garance', difficulty: 2, box: 9, due: 'x', correct: -1, wrong: 'a', categories: 'nope' },
        },
        session: { rounds: -5, score: '7', streak: 2, best: 3 },
        bands: { nature: [0, 2, 2, 6, 'x'], '': [1], temps: 'nope' },
    }),
});
const dirtyState = loadState(dirtyStorage, 'fr');
assert.deepEqual(Object.keys(dirtyState.words), ['13']);
assert.deepEqual(dirtyState.words['13'], {
    text: 'garance',
    difficulty: 2,
    box: 5,
    due: 0,
    correct: 0,
    wrong: 0,
    categories: [],
});
assert.deepEqual(dirtyState.session, { rounds: 0, score: 0, streak: 2, best: 3 });
assert.deepEqual(dirtyState.bands, { nature: [2] });
ok('loadState : entrées parasites et champs invalides sanités (box clampée, compteurs, bands 1-5)');

const legacyStorage = storageWith({
    'vocab:progress:v1:fr': JSON.stringify({ words: { 1: { text: 'ancien', difficulty: 1 } } }),
});
assert.deepEqual(loadState(legacyStorage, 'fr'), newState());
assert.equal(legacyStorage.getItem('vocab:progress:v1:fr') !== null, true);
assert.equal(legacyStorage.getItem('vocab:progress:v2:fr'), null);
ok('loadState : la clé v1 n est ni lue ni migrée');

const fullState = newState();
recordRound(fullState, { targetId: 13, text: 'garance', difficulty: 2, correct: true, categories: ['nature'] });
recordRound(fullState, { targetId: 14, text: 'sillage', difficulty: 2, correct: true, categories: ['nature'] });
const roundTripStorage = storageWith({});
saveState(roundTripStorage, fullState, 'fr');
assert.deepEqual(loadState(roundTripStorage, 'fr'), fullState);
ok('saveState -> loadState : aller-retour stable');

// --- recordRound ------------------------------------------------------------

const NOW = 1_000_000;

const parasite = newState();
const beforeParasite = JSON.stringify(parasite);
assert.deepEqual(recordRound(parasite, { targetId: 'undefined', text: 'x', difficulty: 2, correct: true }), []);
assert.deepEqual(recordRound(parasite, { targetId: 1, text: '', difficulty: 2, correct: true }), []);
assert.deepEqual(recordRound(parasite, { targetId: 1, text: 'mot', difficulty: '2', correct: true }), []);
assert.equal(JSON.stringify(parasite), beforeParasite);
ok('recordRound : rounds parasites ignorés sans toucher l état');

const solo = newState();
assert.deepEqual(
    recordRound(solo, { targetId: 21, text: 'ersatz', difficulty: 3, correct: true, categories: ['nature'], now: NOW }),
    []
);
assert.equal(solo.words['21'].box, 1);
assert.equal(solo.words['21'].due, NOW + 8 * 3600e3);
assert.equal(solo.words['21'].correct, 1);
assert.deepEqual(solo.words['21'].categories, ['nature']);
assert.deepEqual(solo.session, { rounds: 1, score: 1, streak: 1, best: 1 });
ok('recordRound : bonne réponse -> boîte 1, due +8h, catégories enregistrées, session à jour');

recordRound(solo, { targetId: 21, text: 'ersatz', difficulty: 3, correct: true, categories: ['nature'], now: NOW });
assert.equal(solo.words['21'].box, 2);
assert.equal(solo.words['21'].due, NOW + 24 * 3600e3);
ok('recordRound : deuxième bonne réponse -> boîte 2, due +1j');

recordRound(solo, { targetId: 21, text: 'ersatz', difficulty: 3, correct: false, now: NOW });
assert.equal(solo.words['21'].box, 0);
assert.equal(solo.words['21'].due, NOW + 10 * 60e3);
assert.equal(solo.words['21'].wrong, 1);
assert.equal(solo.session.streak, 0);
assert.equal(solo.session.best, 2);
ok('recordRound : mauvaise réponse -> boîte 0, due +10min, série coupée, record conservé');

for (let i = 0; i < 6; i++) {
    recordRound(solo, { targetId: 21, text: 'ersatz', difficulty: 3, correct: true, now: NOW });
}
assert.equal(solo.words['21'].box, 5);
assert.equal(solo.words['21'].due, NOW + 30 * 86400e3);
ok('recordRound : boîte plafonnée à 5, intervalle 30j');

// --- acquisition de bandes ---------------------------------------------------

const duo = newState();
recordRound(duo, { targetId: 31, text: 'ondée', difficulty: 2, correct: true, categories: ['nature'], now: NOW });
assert.deepEqual(
    recordRound(duo, { targetId: 31, text: 'ondée', difficulty: 2, correct: true, categories: ['nature'], now: NOW }),
    []
);
recordRound(duo, { targetId: 32, text: 'vivier', difficulty: 2, correct: true, categories: ['nature'], now: NOW });
assert.deepEqual(
    recordRound(duo, { targetId: 32, text: 'vivier', difficulty: 2, correct: true, categories: ['nature'], now: NOW }),
    [{ category: 'nature', band: 2 }]
);
assert.deepEqual(duo.bands, { nature: [2] });
ok('acquisition : deux mots même catégorie même difficulté à boîte 2 -> bande acquise au deuxième');

const lonely = newState();
for (let i = 0; i < 5; i++) {
    assert.deepEqual(
        recordRound(lonely, { targetId: 41, text: 'soliste', difficulty: 4, correct: true, categories: ['morale'], now: NOW }),
        []
    );
}
assert.deepEqual(lonely.bands, {});
ok('acquisition : un seul mot, même à boîte 5 -> rien');

const shallow = newState();
recordRound(shallow, { targetId: 51, text: 'ancré', difficulty: 2, correct: true, categories: ['nature'], now: NOW });
recordRound(shallow, { targetId: 51, text: 'ancré', difficulty: 2, correct: true, categories: ['nature'], now: NOW });
recordRound(shallow, { targetId: 52, text: 'flottant', difficulty: 2, correct: true, categories: ['nature'], now: NOW });
assert.deepEqual(shallow.bands, {});
ok('acquisition : deux mots mais un seul à boîte >= 2 -> rien');

const mixed = newState();
recordRound(mixed, { targetId: 61, text: 'parcelle', difficulty: 1, correct: true, categories: ['droit'], now: NOW });
recordRound(mixed, { targetId: 61, text: 'parcelle', difficulty: 1, correct: true, categories: ['droit'], now: NOW });
recordRound(mixed, { targetId: 62, text: 'testament', difficulty: 1, correct: true, categories: ['droit'], now: NOW });
assert.deepEqual(
    recordRound(mixed, { targetId: 62, text: 'testament', difficulty: 1, correct: true, categories: ['droit'], now: NOW }),
    [{ category: 'droit', band: 1 }]
);
recordRound(mixed, { targetId: 63, text: 'clause', difficulty: 2, correct: true, categories: ['droit'], now: NOW });
recordRound(mixed, { targetId: 63, text: 'clause', difficulty: 2, correct: true, categories: ['droit'], now: NOW });
recordRound(mixed, { targetId: 64, text: 'legat', difficulty: 2, correct: true, categories: ['droit'], now: NOW });
assert.deepEqual(
    recordRound(mixed, { targetId: 64, text: 'legat', difficulty: 2, correct: true, categories: ['droit'], now: NOW }),
    [{ category: 'droit', band: 2 }]
);
assert.deepEqual(mixed.bands, { droit: [1, 2] });
ok('acquisition : difficultés différentes -> bandes distinctes');

const solid = newState();
recordRound(solid, { targetId: 71, text: 'récif', difficulty: 2, correct: true, categories: ['marine'], now: NOW });
recordRound(solid, { targetId: 71, text: 'récif', difficulty: 2, correct: true, categories: ['marine'], now: NOW });
recordRound(solid, { targetId: 72, text: 'estuaire', difficulty: 2, correct: true, categories: ['marine'], now: NOW });
assert.deepEqual(
    recordRound(solid, { targetId: 72, text: 'estuaire', difficulty: 2, correct: true, categories: ['marine'], now: NOW }),
    [{ category: 'marine', band: 2 }]
);
recordRound(solid, { targetId: 71, text: 'récif', difficulty: 2, correct: false, categories: ['marine'], now: NOW });
assert.equal(solid.words['71'].box, 0);
assert.deepEqual(solid.bands, { marine: [2] });
recordRound(solid, { targetId: 71, text: 'récif', difficulty: 2, correct: true, categories: ['marine'], now: NOW });
assert.deepEqual(
    recordRound(solid, { targetId: 71, text: 'récif', difficulty: 2, correct: true, categories: ['marine'], now: NOW }),
    []
);
assert.equal(solid.words['71'].box, 2);
assert.deepEqual(solid.bands, { marine: [2] });
ok('acquisition : définitive, pas de régression quand un mot retombe à la boîte 0');

const multi = newState();
recordRound(multi, { targetId: 81, text: 'embâcle', difficulty: 3, correct: true, categories: ['nature', 'temps'], now: NOW });
recordRound(multi, { targetId: 81, text: 'embâcle', difficulty: 3, correct: true, categories: ['nature', 'temps'], now: NOW });
recordRound(multi, { targetId: 82, text: 'marée', difficulty: 3, correct: true, categories: ['nature', 'temps'], now: NOW });
recordRound(multi, { targetId: 82, text: 'marée', difficulty: 3, correct: true, categories: ['nature', 'temps'], now: NOW });
assert.deepEqual(multi.bands, { nature: [3], temps: [3] });
ok('acquisition : un mot multi-catégories acquiert dans chacune');

// --- niveau dérivé -----------------------------------------------------------

const leveled = newState();
assert.equal(categoryLevel(leveled, 'nature'), 1);
leveled.bands = { nature: [1], temps: [1, 3] };
assert.equal(categoryLevel(leveled, 'nature'), 1);
assert.equal(categoryLevel(leveled, 'temps'), 3);
assert.equal(categoryLevel(leveled, 'inconnue'), 1);
ok('categoryLevel : plus haute bande, 1 par défaut');

// --- dueWords / counts -------------------------------------------------------

const scheduling = newState();
scheduling.words = {
    1: { text: 'vieux', difficulty: 1, box: 4, due: 500, correct: 3, wrong: 1, categories: [] },
    2: { text: 'récent', difficulty: 2, box: 2, due: 100, correct: 2, wrong: 0, categories: [] },
    3: { text: 'futur', difficulty: 3, box: 1, due: NOW + 999_999, correct: 1, wrong: 0, categories: [] },
};
const due = dueWords(scheduling, NOW);
assert.deepEqual(
    due.map(word => word.id),
    ['2', '1']
);
ok('dueWords : passés inclus et triés par échéance, futurs exclus');

const tally = counts(scheduling, NOW);
assert.deepEqual(tally, { seen: 3, mastered: 1, learning: 2, due: 2 });
ok('counts : vus, maîtrisés (boîte >= 4), en cours, à revoir');

// --- href de rejouer -----------------------------------------------------------

function stateForReplay({ due: isDue, bands: bandList }) {
    const state = newState();
    state.words = {
        7: {
            text: 'garance',
            difficulty: 2,
            box: 2,
            due: isDue ? 0 : Date.now() + 86400e3,
            correct: 2,
            wrong: 0,
            categories: ['nature'],
        },
    };
    if (bandList) state.bands = { nature: bandList };
    return state;
}

assert.equal(
    buildReplayHref({ category: 'nature', sticky: true, mode: 'identification' }, '/fr', stateForReplay({ due: true })),
    '/fr/game?category=nature&word=7'
);
ok('rejouer : catégorie sans mode choisi -> le mode se re-randomise (pas de mode= dans l’href), mémoire d’abord');

assert.equal(
    buildReplayHref({ category: 'nature', modeFixe: true, mode: 'identification' }, '/fr', stateForReplay({ due: true })),
    '/fr/game?category=nature&mode=identification&word=7'
);
ok('rejouer : catégorie + mode choisi explicitement -> mode conservé avant le mot dû');

const originalRandom = Math.random;
try {
    Math.random = () => 0.9;
    assert.equal(
        buildReplayHref(
            { category: 'nature', modeFixe: true, mode: 'reverse' },
            '/fr',
            stateForReplay({ due: false, bands: [2] })
        ),
        '/fr/game?category=nature&mode=reverse&band=2'
    );
    ok('rejouer : catégorie niveau 2, pas de sonde (random 0.9) -> bande frontière 2');

    Math.random = () => 0.1;
    assert.equal(
        buildReplayHref(
            { category: 'nature', modeFixe: true, mode: 'reverse' },
            '/fr',
            stateForReplay({ due: false, bands: [2] })
        ),
        '/fr/game?category=nature&mode=reverse&band=3'
    );
    ok('rejouer : catégorie niveau 2, sonde (random 0.1) -> bande 3');

    assert.equal(
        buildReplayHref({ category: 'nature' }, '/fr', stateForReplay({ due: false, bands: [2, 5] })),
        '/fr/game?category=nature&band=5'
    );
    ok('rejouer : sonde au niveau 5 -> bande clampée à 5');

    Math.random = () => 0.1;
    assert.equal(
        buildReplayHref({ category: 'nature' }, '/fr', stateForReplay({ due: false })),
        '/fr/game?category=nature&band=2'
    );
    ok('rejouer : catégorie nouvelle (niveau 1), sonde -> bande 2');
} finally {
    Math.random = originalRandom;
}

assert.equal(
    buildReplayHref(
        { sticky: true, mode: 'reverse', replayHref: '/fr/game?mode=reverse' },
        '/fr',
        stateForReplay({ due: true })
    ),
    '/fr/game?mode=reverse&word=7'
);
ok('rejouer : sans catégorie + mots dus -> href serveur + mot=');

assert.equal(
    buildReplayHref({ replayHref: '/fr/game?mode=reverse' }, '/fr', stateForReplay({ due: false })),
    '/fr/game?mode=reverse'
);
ok('rejouer : sans catégorie + pas de dus -> href serveur tel quel');

assert.equal(buildReplayHref({}, '/fr', stateForReplay({ due: false })), '/fr/game');
ok('rejouer : sans catégorie ni href serveur -> jeu surprise');

// --- cookie de pools de solidité (boîte >= 2 / >= 3) ---------------------------

const poolState = newState();
recordRound(poolState, { targetId: 1, text: 'a', difficulty: 2, correct: true, categories: ['nature'] });
recordRound(poolState, { targetId: 1, text: 'a', difficulty: 2, correct: true, categories: ['nature'] });
recordRound(poolState, { targetId: 1, text: 'a', difficulty: 2, correct: true, categories: ['nature'] });
recordRound(poolState, { targetId: 2, text: 'b', difficulty: 2, correct: true, categories: ['nature'] });
recordRound(poolState, { targetId: 2, text: 'b', difficulty: 2, correct: true, categories: ['nature'] });
recordRound(poolState, { targetId: 2, text: 'b', difficulty: 2, correct: true, categories: ['nature'] });
assert.equal(poolCookieValue(poolState), '2:1,2|3:1,2');
ok('poolCookieValue : boîtes >= 2 et >= 3 publiées (2:1,2|3:1,2)');

console.info(`\nTests unitaires v2 : ${checks} vérifications ok`);
