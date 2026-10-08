import Express from 'express';
import * as Vocab from './vocab.js';
import { Difficulties } from './difficulties.js';

const port = process.env.PORT ?? '80';

const LANGUAGES = (process.env.LANGUAGES ?? process.env.LANGUAGE ?? 'fr')
    .split(',')
    .map(lang => lang.trim())
    .filter(Boolean);
const deploymentBase = process.env.BASE_PATH ?? '';

const app = Express();

app.use(Express.urlencoded({ extended: false }));

app.set('view engine', 'ejs');
app.set('views', 'views');
app.locals.description =
    'Apprendre le vocabulaire français par le jeu : définitions, nuances, mots proches et confusions classiques.';
app.locals.difficulties = Difficulties;
app.locals.rootBase = deploymentBase;

function setDefaultLocals(res) {
    if (!res.locals.language) {
        res.locals.language = LANGUAGES[0];
        res.locals.base = `${deploymentBase}/${LANGUAGES[0]}`;
    }
}

// Root: language choice
const LANGUAGE_NAMES = { fr: 'Français', en: 'English' };
app.get('/', (req, res) => {
    res.render('choose', {
        base: `${deploymentBase}/${LANGUAGES[0]}`,
        languages: LANGUAGES.map(lang => ({
            code: lang,
            name: LANGUAGE_NAMES[lang] ?? lang,
            href: `${deploymentBase}/${lang}`,
        })),
    });
});

// Legacy paths without the language prefix: redirect to the default language
const LANGLESS_PREFIXES = ['words', 'game', 'progress', 'style.css', 'game.js'];
app.use((req, res, next) => {
    const firstSegment = req.path.split('/')[1];
    if (req.method === 'GET' && LANGLESS_PREFIXES.includes(firstSegment)) {
        res.redirect(302, `${deploymentBase}/${LANGUAGES[0]}${req.originalUrl}`);
        return;
    }
    next();
});

const router = Express.Router();

router.use((req, res, next) => {
    if ((req.path === '/style.css' || req.path === '/game.js') && req.query.v !== undefined) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
    next();
});
router.use(Express.static('static'));

// Locale middleware
router.use((req, res, next) => {
    res.locals.locale = firstValidLocale(req.acceptsLanguages());
    next();
});

function firstValidLocale(langs) {
    for (const lang of langs ?? []) {
        if (lang === '*' || lang === undefined) continue;
        try {
            Intl.getCanonicalLocales(lang);
            return lang;
        } catch {
            continue;
        }
    }
    return 'fr';
}

// Homepage route
router.get('/', async (req, res) => {
    const stats = await Vocab.getStats(res.locals.language);
    const playableCategories = await Vocab.getPlayableCategories(res.locals.language);
    res.render('index', { stats, playableCategories });
});

// Word list route
router.get('/words', async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 60) : '';
    const category = typeof req.query.category === 'string' ? req.query.category.trim().slice(0, 60) : '';
    const pageParam = Number.parseInt(req.query.page, 10);
    const { words, total, page, pageCount } = await Vocab.getWordsWithMeta({
        q,
        category,
        page: Number.isInteger(pageParam) && pageParam > 0 ? Math.min(pageParam, 1000) : 1,
        language: res.locals.language,
    });
    const categories = await Vocab.getCategoriesWithCounts(res.locals.language);
    const groups = [1, 2, 3, 4, 5]
        .map(level => ({ ...Difficulties[level], words: words.filter(word => word.difficulty === level) }))
        .filter(group => group.words.length > 0);
    res.render('words', { words, groups, categories, q, category, total, page, pageCount });
});

// Word route
router.get('/words/:word', async (req, res) => {
    const word = await Vocab.getWordByText(req.params.word, res.locals.language);
    if (word) {
        res.render('word', { word });
    } else {
        res.status(404).render('error', { code: 404, message: 'Mot non trouvé' });
    }
});

// Game route
router.get('/game', async (req, res) => {
    const motId = Number.parseInt(req.query.word, 10);
    const bandId = Number.parseInt(req.query.band, 10);
    const mode = ['identification', 'reverse', 'frappe', 'contexte', 'jumelage', 'frappe-contexte'].includes(req.query.mode)
        ? req.query.mode
        : null;
    const track = ['acquisition', 'distinction'].includes(req.query.track) ? req.query.track : null;
    const category = typeof req.query.category === 'string' ? req.query.category.trim().slice(0, 60) : '';
    const band = Number.isInteger(bandId) ? Math.max(1, Math.min(5, bandId)) : null;
    const game = await Vocab.getGame({
        wordId: Number.isInteger(motId) ? motId : null,
        mode,
        track,
        band,
        category: category || null,
        language: res.locals.language,
    });
    res.render('game', {
        game,
        sticky: mode !== null || track !== null || Number.isInteger(motId) || category !== '',
        track,
        modeFixe: mode !== null,
        category,
        band,
        categoryTotal: category ? await Vocab.getCategoryTotal(category, res.locals.language) : null,
    });
});

// Progress route
router.get('/progress', (req, res) => {
    res.render('progress');
});

// Game answer route
router.post('/game/answer', async (req, res) => {
    const body = req.body ?? {};
    const mode = ['identification', 'reverse', 'frappe', 'contexte', 'jumelage', 'frappe-contexte'].includes(body.mode)
        ? body.mode
        : 'identification';
    const sticky = body.sticky === '1';
    const modeFixe = body.modefixe === '1';
    const track = ['acquisition', 'distinction'].includes(body.track) ? body.track : null;
    const category = typeof body.category === 'string' ? body.category.trim().slice(0, 60) : '';
    const bandId = Number.parseInt(body.band, 10);
    const band = Number.isInteger(bandId) ? Math.max(1, Math.min(5, bandId)) : null;
    const categoryTotalId = Number.parseInt(body.categorytotal, 10);
    const categoryTotal = Number.isInteger(categoryTotalId) && categoryTotalId > 0 ? categoryTotalId : null;
    const base = res.locals.base;
    const replayHref = track ? `${base}/game?track=${track}` : `${base}/game?mode=${mode}`;

    if (mode === 'frappe' || mode === 'frappe-contexte') {
        const targetId = Number.parseInt(body.target, 10);
        const guess = typeof body.guess === 'string' ? body.guess.slice(0, 60) : '';
        if (!Number.isInteger(targetId) || guess.trim() === '') {
            res.status(400).render('error', { code: 400, message: 'Réponse invalide' });
            return;
        }
        const target = await Vocab.getWordById(targetId);
        if (!target) {
            res.status(404).render('error', { code: 404, message: 'Mot non trouvé' });
            return;
        }
        const sentence = mode === 'frappe-contexte' && typeof body.sentence === 'string' ? body.sentence.slice(0, 500) : null;
        res.render('game-result', {
            mode,
            correct: Vocab.isCloseMatch(guess, target.text),
            guess,
            definition: target.short_definition,
            sentence,
            example: target.examples.length > 0 ? target.examples[Math.floor(Math.random() * target.examples.length)] : null,
            replayHref: sticky ? replayHref : `${base}/game`,
            categoryTotal,
            sticky,
            modeFixe,
            target,
            choice: null,
            category,
            band,
        });
        return;
    }

    const targetId = Number.parseInt(body.target, 10);
    const choiceId = Number.parseInt(body.choice, 10);
    if (!Number.isInteger(targetId) || !Number.isInteger(choiceId)) {
        res.status(400).render('error', { code: 400, message: 'Réponse invalide' });
        return;
    }
    const sentence = mode === 'contexte' && typeof body.sentence === 'string' ? body.sentence.slice(0, 500) : null;
    const nuance =
        (mode === 'contexte' || mode === 'jumelage') && typeof body.nuance === 'string' ? body.nuance.slice(0, 500) : null;
    const otherId = mode === 'jumelage' ? Number.parseInt(body.other, 10) : null;
    const words = await Promise.all([
        Vocab.getWordById(targetId),
        Vocab.getWordById(choiceId),
        Number.isInteger(otherId) ? Vocab.getWordById(otherId) : null,
    ]);
    const [target, choice, other] = words;
    if (!target || !choice) {
        res.status(404).render('error', { code: 404, message: 'Mot non trouvé' });
        return;
    }
    res.render('game-result', {
        correct: target.id === choice.id,
        mode,
        definition: target.short_definition,
        sentence,
        nuance,
        other: other ?? null,
        example: target.examples.length > 0 ? target.examples[Math.floor(Math.random() * target.examples.length)] : null,
        replayHref: sticky ? replayHref : `${base}/game`,
        categoryTotal,
        sticky,
        modeFixe,
        target,
        choice,
        category,
        band,
    });
});

// 404 handler (within a language)
router.use((req, res) => {
    setDefaultLocals(res);
    res.status(404).render('error', { code: 404, message: 'Page non trouvée' });
});

// Language gate: serve each language under its own path prefix
app.use(
    '/:lang',
    (req, res, next) => {
        const lang = String(req.params.lang ?? '').toLowerCase();
        if (!LANGUAGES.includes(lang)) {
            res.status(404).render('error-neutral', { root: deploymentBase });
            return;
        }
        res.locals.language = lang;
        res.locals.base = `${deploymentBase}/${lang}`;
        next();
    },
    router
);

// 404 for anything else (unknown language or path): neutral page, no language dressing
app.use((req, res) => {
    res.status(404).render('error-neutral', { root: deploymentBase });
});

// Error handling
app.use((req, res, next) => {
    const origEnd = res.end;
    res.end = function (...args) {
        Promise.resolve()
            .then(() => origEnd.apply(res, args))
            .catch(next);
    };
    next();
});

app.use((err, req, res, _next) => {
    console.error(err);
    setDefaultLocals(res);
    res.status(500).render('error', { code: 500, message: 'Erreur interne du serveur' });
});

// Start server
app.listen(port, err => {
    if (err) console.error(err);
    else console.info('HTTP server started');
});
