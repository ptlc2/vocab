// Tests du choix de cible dans les paires (jumelage/frappe-contexte/contexte) — node tests/pair-flip.test.mjs, sans dépendance.
// pairTargetFlip rend true quand la cible est a, false quand c'est b.
import assert from 'node:assert/strict';
import { pairTargetFlip } from '../vocab.js';

let checks = 0;
function ok(name) {
    checks += 1;
    console.info(`ok ${checks} - ${name}`);
}

function pairWith(flags = {}) {
    return { a_id: 11, b_id: 22, a_in_cat: flags.a_in_cat ?? null, b_in_cat: flags.b_in_cat ?? null };
}

function alwaysBoolean(pair, pool, times = 50) {
    for (let i = 0; i < times; i++) {
        const flip = pairTargetFlip(pair, pool);
        assert.equal(typeof flip, 'boolean', 'le flip rend toujours un booléen');
    }
}

// --- sans pool ni catégorie : hasard pur ------------------------------------

alwaysBoolean(pairWith(), null);
ok('sans pool ni catégorie : hasard pur, toujours un booléen');

// --- le pool force la cible sur le mot du pool -------------------------------

assert.equal(pairTargetFlip(pairWith(), [11]), true);
assert.equal(pairTargetFlip(pairWith(), [22]), false);
for (let i = 0; i < 20; i++) {
    assert.equal(pairTargetFlip(pairWith(), [11]), true);
    assert.equal(pairTargetFlip(pairWith(), [22]), false);
}
ok('pool : seul a dans le pool -> cible a ; seul b -> cible b (jamais l inverse)');

alwaysBoolean(pairWith(), [11, 22]);
ok('pool : les deux dans le pool -> hasard');

// --- la catégorie force la cible sur le mot de la catégorie ------------------

assert.equal(pairTargetFlip(pairWith({ a_in_cat: true, b_in_cat: false }), null), true);
assert.equal(pairTargetFlip(pairWith({ a_in_cat: false, b_in_cat: true }), null), false);
for (let i = 0; i < 20; i++) {
    assert.equal(pairTargetFlip(pairWith({ a_in_cat: true, b_in_cat: false }), null), true);
    assert.equal(pairTargetFlip(pairWith({ a_in_cat: false, b_in_cat: true }), null), false);
}
ok('catégorie : seul a dans la catégorie -> cible a ; seul b -> cible b');

alwaysBoolean(pairWith({ a_in_cat: true, b_in_cat: true }), null);
alwaysBoolean(pairWith({ a_in_cat: false, b_in_cat: false }), null);
ok('catégorie : les deux (ou aucun) -> hasard');

alwaysBoolean({ a_id: 11, b_id: 22 }, null);
ok('catégorie absente (drapeaux manquants) : pas de préférence, hasard');

// --- le pool prime sur la catégorie ------------------------------------------

assert.equal(pairTargetFlip(pairWith({ a_in_cat: false, b_in_cat: true }), [11]), true);
assert.equal(pairTargetFlip(pairWith({ a_in_cat: true, b_in_cat: false }), [22]), false);
for (let i = 0; i < 20; i++) {
    assert.equal(pairTargetFlip(pairWith({ a_in_cat: false, b_in_cat: true }), [11]), true);
    assert.equal(pairTargetFlip(pairWith({ a_in_cat: true, b_in_cat: false }), [22]), false);
}
ok('pool + catégorie opposés : le pool prime (cible solide pour le mode)');

console.info(`\nTest pair-flip : ${checks} vérifications ok`);
