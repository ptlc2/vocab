// Test jsdom : le moteur de jeu côté client (dictionnaire + rendu + réponse), sur des données réelles servies par le stack local.
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

function installDom(html, path, dictionaryData) {
    const dom = new JSDOM(html, { url: `${BASE_URL}${path}` });
    globalThis.document = dom.window.document;
    globalThis.window = dom.window;
    globalThis.localStorage = dom.window.localStorage;
    globalThis.fetch = async () => ({ ok: true, json: async () => dictionaryData });
    return dom;
}

// Dictionnaire réel servi par le stack
const dictionaryJson = await (await fetch(`${BASE_URL}/fr/dictionary.json`)).json();
assert.equal(dictionaryJson.words.length > 100, true, `dictionnaire fourni (${dictionaryJson.words.length} mots)`);
assert.equal(dictionaryJson.confusions.length > 50, true, 'confusions fournies');
ok(`dictionnaire servi : ${dictionaryJson.words.length} mots, ${dictionaryJson.confusions.length} confusions`);

// Page de jeu : coquille + moteur
const gameHtml = await get('/fr/game?category=nature');
installDom(gameHtml, '/fr/game?category=nature', dictionaryJson);
assert.notEqual(document.getElementById('game-root'), null, 'la coquille de jeu est rendue');
assert.notEqual(document.body.dataset.dictionary, undefined, 'l’URL du dictionnaire est sur le body');
ok('page de jeu : coquille + data-dictionary');

const game = await import('../static/game.js');
const state = game.loadState(globalThis.localStorage, 'fr');

// État neuf : la mémoire d’abord ne déclenche pas, identification/contexte seulement
const freshRound = game.pickRound(dictionaryJson, state, { category: 'nature' });
assert.equal(['identification', 'contexte'].includes(freshRound.mode), true, `mode neuf : ${freshRound.mode}`);
assert.equal(freshRound.options.length >= 2, true, 'options rendues');
ok('moteur : état neuf -> identification/contexte, pas de modes exigeants');

// Rendu d’un round + réponse + enregistrement (la cible est interne au moteur, par design invisible dans le DOM)
const root = document.getElementById('game-root');
game.startGame(root, dictionaryJson, { base: '/fr', language: 'fr', storage: globalThis.localStorage, state });
let form = root.querySelector('form.game-card');
assert.notEqual(form, null, 'un round est rendu dans la coquille');
assert.notEqual(root.querySelector('.game-mode span'), null, 'badge de mode rendu');
ok('moteur : round rendu dans la coquille (badge, question, options/stats)');

// Simuler une réponse : cliquer la première option
const optionButtons = [...form.querySelectorAll('.option-btn')];
assert.equal(optionButtons.length >= 2, true, 'des options cliquables existent');
optionButtons[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const resultCard = root.querySelector('.result-card');
assert.notEqual(resultCard, null, 'la carte résultat remplace le round après clic');
assert.notEqual(root.querySelector('.verdict'), null, 'le verdict est rendu');
assert.notEqual(root.querySelector('.progress-block'), null, 'le bloc progression est rendu');
const savedAfter = JSON.parse(globalThis.localStorage.getItem('vocab:progress:v2:fr'));
assert.notEqual(savedAfter, null, 'le round est enregistré dans la save v2');
assert.equal(Object.keys(savedAfter.words).length >= 1, true, 'au moins un mot vu');
ok('moteur : clic sur une option -> résultat + progression + save v2');

// Rejouer : un nouveau round remplace le résultat
const replayButton = root.querySelector('.result-actions .btn-primary');
replayButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
form = root.querySelector('form.game-card');
assert.notEqual(form, null, 'Rejouer -> nouveau round rendu');
ok('moteur : Rejouer -> nouveau round en place');

console.info(`\nTest jsdom moteur : ${checks} vérifications ok`);
