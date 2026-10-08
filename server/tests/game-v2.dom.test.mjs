// Test jsdom : le client v2 sur de vraies pages servies par le stack local (dind:6770).
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const BASE_URL = process.env.VOCAB_TEST_URL ?? 'http://dind:6770';

let checks = 0;
function ok(name) {
    checks += 1;
    console.info(`ok ${checks} - ${name}`);
}

async function get(path) {
    const response = await fetch(`${BASE_URL}${path}`);
    assert.equal(response.status, 200, `GET ${path} doit répondre 200`);
    return response.text();
}

async function post(path, form) {
    const response = await fetch(`${BASE_URL}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(),
    });
    assert.equal(response.status, 200, `POST ${path} doit répondre 200`);
    return response.text();
}

function installDom(html, path) {
    const dom = new JSDOM(html, { url: `${BASE_URL}${path}` });
    globalThis.document = dom.window.document;
    globalThis.window = dom.window;
    globalThis.localStorage = dom.window.localStorage;
    return dom;
}

// Deux mots distincts de la catégorie nature, difficulté 2 (tirage réel côté serveur).
async function drawTwoNatureBand2Words() {
    const seen = new Set();
    for (let i = 0; i < 40 && seen.size < 2; i++) {
        const html = await get('/fr/game?categorie=nature&bande=2');
        const match = html.match(/name="target"\s+value="(\d+)"/);
        assert.notEqual(match, null, 'la carte de jeu expose l identifiant cible');
        seen.add(match[1]);
    }
    assert.equal(seen.size, 2, 'deux mots distincts tirés en nature bande 2');
    return [...seen];
}

const [wordA, wordB] = await drawTwoNatureBand2Words();

// Scénario A : round juste avec catégorie, état pré-semé (A boîte 2, B boîte 1) -> acquisition attendue.
const correctHtml = await post('/fr/game/answer', {
    mode: 'identification',
    target: wordB,
    choice: wordB,
    sticky: '1',
    categorie: 'nature',
});

const seed = {
    words: {
        [wordA]: {
            text: 'mot ancien',
            difficulty: 2,
            box: 2,
            due: Date.now() + 86400e3,
            correct: 2,
            wrong: 0,
            categories: ['nature'],
        },
        [wordB]: {
            text: 'mot neuf',
            difficulty: 2,
            box: 1,
            due: Date.now() + 86400e3,
            correct: 1,
            wrong: 0,
            categories: ['nature'],
        },
    },
    session: { rounds: 3, score: 3, streak: 3, best: 3 },
    bands: {},
};

installDom(correctHtml, '/fr/game/answer');
globalThis.localStorage.setItem('vocab:progress:v2:fr', JSON.stringify(seed));

const originalRandom = Math.random;
let gameModule;
try {
    Math.random = () => 0.1; // sonde (1 chance sur 4) : niveau 2 -> bande 3
    gameModule = await import('../static/game.js');
} finally {
    Math.random = originalRandom;
}

const card = globalThis.document.querySelector('.result-card[data-mode]');
assert.notEqual(card, null, 'la carte résultat existe');
assert.equal(card.dataset.categorie, 'nature', 'la carte résultat porte la catégorie');
assert.equal(card.dataset.difficulty, '2', 'le mot cible est bien de difficulté 2');
assert.equal(card.dataset.sticky, 'true', 'le mode a été choisi explicitement');
assert.ok(JSON.parse(card.dataset.categories).includes('nature'), 'le mot cible appartient à nature');
const block = card.querySelector('.progress-block');
assert.notEqual(block, null, 'le bloc progression est injecté');
assert.equal(block.querySelector('.progress-line').textContent, 'Score 4 · Série 4 (record 4) · catégorie nature · niveau 2/5');
ok('bloc progression : score, série, record + catégorie et niveau dérivé');

const celebration = block.querySelector('.progress-line.celebration');
assert.notEqual(celebration, null, 'la célébration d acquisition est affichée');
assert.equal(celebration.textContent, 'Bande 2 acquise en nature !');
ok('célébration : bande 2 acquise en nature, visible une fois');

const replay = card.querySelector('.result-actions .btn-primary');
assert.equal(replay.getAttribute('href'), '/fr/game?categorie=nature&bande=3');
ok('rejouer : href reconstruit (catégorie + sonde bande 3, SANS mode épinglé : pas choisi explicitement)');

const saved = JSON.parse(globalThis.localStorage.getItem('vocab:progress:v2:fr'));
assert.equal(saved.words[wordB].box, 2);
assert.equal(saved.session.score, 4);
assert.deepEqual(saved.bands.nature, [2]);
ok('enregistrement : le round est sauvegardé dans la clé v2 (boîte 2, bandes [2])');

const explicitHtml = await post('/fr/game/answer', {
    mode: 'identification',
    target: wordA,
    choice: wordA,
    sticky: '1',
    modefixe: '1',
    categorie: 'nature',
});
installDom(explicitHtml, '/fr/game/answer');
const explicitCard = globalThis.document.querySelector('.result-card[data-mode]');
assert.equal(explicitCard.dataset.modeFixe, 'true', 'le drapeau mode choisi explicitement traverse la chaîne');
const explicitState = gameModule.loadState(globalThis.localStorage, 'fr');
explicitState.words['555'] = {
    text: 'mot dû distinct',
    difficulty: 2,
    box: 0,
    due: 1,
    correct: 1,
    wrong: 1,
    categories: ['nature'],
};
gameModule.renderResultCard(explicitCard, '/fr', explicitState);
assert.equal(
    explicitCard.querySelector('.result-actions .btn-primary').getAttribute('href'),
    '/fr/game?categorie=nature&mode=identification&mot=555'
);
ok('rejouer : mode choisi explicitement -> conservé dans l’href (la mémoire prime)');

// Scénario B : round faux sans catégorie, stockage vierge -> pas de célébration, href serveur conservé.
const wrongHtml = await post('/fr/game/answer', { mode: 'identification', target: wordB, choice: wordA });
installDom(wrongHtml, '/fr/game/answer');
const wrongCard = globalThis.document.querySelector('.result-card[data-mode]');
assert.equal('categorie' in wrongCard.dataset, false, 'pas de data-categorie sans catégorie postée');

const stateB = gameModule.loadState(globalThis.localStorage, 'fr');
gameModule.renderResultCard(wrongCard, '/fr', stateB);
gameModule.saveState(globalThis.localStorage, stateB, 'fr');

const wrongBlock = wrongCard.querySelector('.progress-block');
assert.equal(wrongBlock.querySelector('.progress-line').textContent, 'Score 0 · Série 0 (record 0)');
assert.equal(wrongBlock.querySelector('.progress-line.celebration'), null);
assert.equal(wrongCard.querySelector('.result-actions .btn-primary').getAttribute('href'), '/fr/game');
const savedB = JSON.parse(globalThis.localStorage.getItem('vocab:progress:v2:fr'));
assert.equal(savedB.words[wordB].wrong, 1);
ok('sans catégorie : bloc sobre, pas de célébration, href serveur tel quel, échec enregistré');

// Scénario C : grille de catégories de l accueil enrichie (badges + groupes).
const homeHtml = await get('/fr');
installDom(homeHtml, '/fr/');
const grid = globalThis.document.getElementById('category-grid');
assert.notEqual(grid, null, 'la grille de catégories est rendue côté serveur');
const cards = grid.querySelectorAll('[data-category]');
assert.ok(cards.length >= 10, `au moins 10 cartes (trouvé : ${cards.length})`);

const homeState = gameModule.loadState(globalThis.localStorage, 'fr');
homeState.bands = { nature: [2] };
homeState.words['999'] = {
    text: 'mot témoin',
    difficulty: 1,
    box: 1,
    due: Date.now() + 86400e3,
    correct: 1,
    wrong: 0,
    categories: ['philosophie'],
};
gameModule.renderHomeCategories(grid, homeState);

const groups = globalThis.document.querySelectorAll('.category-groups .category-group');
assert.equal(groups.length, 2, 'deux groupes visuels');
assert.equal(groups[0].querySelector('.group-title').textContent, 'Tes catégories');
assert.equal(groups[1].querySelector('.group-title').textContent, 'À explorer');
const mineCards = [...groups[0].querySelectorAll('[data-category]')];
assert.ok(mineCards.length >= 2, `au moins nature et philosophie dans tes catégories (trouvé : ${mineCards.length})`);
const natureCard = mineCards.find(card => card.dataset.category === 'nature');
assert.equal(natureCard.querySelector('.level-badge').textContent, 'niveau 2/5');
const philosophieCard = mineCards.find(card => card.dataset.category === 'philosophie');
assert.notEqual(philosophieCard, null, 'philosophie (mot vu, pas de bande) est dans tes catégories');
assert.equal(philosophieCard.querySelector('.level-badge').textContent, 'niveau 1/5');
const exploreCards = [...groups[1].querySelectorAll('[data-category]')];
assert.equal(exploreCards.length + mineCards.length, cards.length, 'toutes les cartes sont réparties');
for (const card of exploreCards) {
    assert.equal(card.querySelector('.level-badge').textContent, 'nouvelle');
}
ok('accueil : jouées (bande acquise ou mot vu) vs à explorer ; niveau X/5, niveau 1/5, nouvelle');

console.info(`\nTest jsdom v2 : ${checks} vérifications ok`);
