import Express from 'express';
import * as Vocab from './vocab.js';
import { getDictionary, getDictionaryVersion } from './dictionary.js';
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
app.locals.cssVersion = 5;
app.locals.jsVersion = 21;

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
            href: `${deploymentBase}/${lang}/`,
        })),
    });
});

// Legacy paths without the language prefix: redirect to the default language
const LANGLESS_PREFIXES = ['words', 'game', 'progress'];
app.use((req, res, next) => {
    const firstSegment = req.path.split('/')[1];
    if (req.method === 'GET' && LANGLESS_PREFIXES.includes(firstSegment)) {
        res.redirect(302, `${deploymentBase}/${LANGUAGES[0]}${req.originalUrl}`);
        return;
    }
    next();
});

// Static assets served once at the root (single URL, single cache entry);
// the per-language copies stay mounted below for pages cached with old URLs.
app.use((req, res, next) => {
    const file = req.path.split('/').pop();
    if ((file === 'style.css' || file === 'game.js') && req.query.v !== undefined) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
    next();
});
app.use(Express.static('static'));

const router = Express.Router();

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

// Dictionary export: the whole playable data of a language, versioned and immutable-cached
router.get('/dictionary.json', async (req, res) => {
    const dictionary = await getDictionary(res.locals.language);
    if (!dictionary) {
        setDefaultLocals(res);
        res.status(404).render('error', { code: 404, message: 'Langue sans mots' });
        return;
    }
    if (req.query.v !== undefined) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
        res.redirect(302, `${res.locals.base}/dictionary.json?v=${await getDictionaryVersion(res.locals.language)}`);
        return;
    }
    res.json(dictionary);
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

// Word route: the same shell as the game — the engine renders the fiche from the dictionary (URL decides)
router.get('/words/:word', async (req, res) => {
    const dictionaryVersion = await getDictionaryVersion(res.locals.language);
    res.render('game', { dictionaryUrl: `${res.locals.base}/dictionary.json?v=${dictionaryVersion}` });
});

// Game route: static shell, the engine (client) does everything.
// La coquille est la même pour toutes les sessions -> cacheable par le service worker,
// la version du dictionnaire voyage dans le HTML (data-dictionary) pour casser le cache.
router.get('/game', async (req, res) => {
    const dictionaryVersion = await getDictionaryVersion(res.locals.language);
    res.render('game', { dictionaryUrl: `${res.locals.base}/dictionary.json?v=${dictionaryVersion}` });
});

// Progress route
router.get('/progress', (req, res) => {
    res.render('progress');
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
            res.status(404).render('error-neutral');
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
    res.status(404).render('error-neutral');
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
