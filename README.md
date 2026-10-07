# Vocab — apprendre le vocabulaire par le jeu

**Vocab** est un mini-jeu lexical conçu pour enrichir le vocabulaire de manière progressive, ludique et exigeante.  
Le projet privilégie, dans un premier temps, une **expérience strictement solo**, pensée comme un terrain d’entraînement personnel où la curiosité linguistique est constamment sollicitée.

L’objectif n’est pas l’accumulation mécanique de mots, mais leur **appropriation fine** : sens, nuances, et justesse d’usage.

---

## Modes de jeu

### 🧠 Acquisition lexicale
Ce mode constitue le socle du jeu.

Le joueur est confronté à de nouveaux mots, présentés avec leurs définitions, parfois mises en tension par des propositions voisines ou des formulations piégeuses. Selon les variantes, il peut s’agir de :
- retrouver le mot à partir de sa définition,
- identifier la définition correcte d’un mot donné,
- reconnaître l’usage approprié d’un terme dans un contexte précis.

Chaque réussite renforce la familiarité avec le mot ; les échecs, eux, déclenchent des rappels ultérieurs afin d’ancrer durablement le sens.

---

### ⚖️ Distinction sémantique
Ce mode est dédié à l’exploration des **nuances lexicales**.

Deux mots proches — synonymes imparfaits, faux jumeaux, termes souvent confondus — sont mis en regard. Le joueur doit :
- discerner leurs différences de sens,
- choisir le mot le plus juste selon un contexte donné,
- associer chaque mot à sa définition spécifique.

Ce mode vise à affiner la précision expressive et à développer une sensibilité linguistique plus subtile, là où le vocabulaire devient un instrument de pensée.

---

## Niveaux de difficulté

Le jeu s’organise autour d’une gradation lexicale, où chaque palier introduit des mots perçus comme plus abstraits, plus rares ou plus marqués stylistiquement :

- **Basique** — vocabulaire courant, immédiatement accessible  
- **Usuel** — lexique standard, légèrement plus précis ou abstrait  
- **Soutenu** — termes fréquents dans l’écrit exigeant ou la presse de fond  
- **Littéraire** — vocabulaire rare, expressif, souvent marqué stylistiquement  
- **Érudit** — mots savants, académiques ou d’origine savante, à forte densité conceptuelle  

La progression s’effectue naturellement, en fonction des réussites du joueur.

---

## Idées annexes

### 📚 Collection de mots
Chaque mot correctement assimilé peut être intégré à une **collection personnelle**.

Ces collections sont organisées par **catégories thématiques ou stylistiques** (émotions, abstractions, vocabulaire littéraire, etc.) et se débloquent progressivement au fil des réussites. Elles servent à la fois de :
- trace visible de la progression,
- outil de révision ciblée,
- incitation à explorer des champs lexicaux plus exigeants.

---

**Vocab** se veut à la fois jeu et atelier linguistique : un espace où l’on apprend à manier les mots avec justesse, élégance et discernement.

---

## Développement

Stack : Node (Express 5 + EJS), PostgreSQL 18 (+ `pg_trgm`), génération lexicale par LLM — Mistral, OpenAI ou Fireworks au choix.

```bash
# .env à la racine (gitignoré) :
# MISTRAL_API_KEY=…

docker compose up -d --build
docker compose exec -T database psql -U user -d vocab < database/sample.sql

docker compose exec server npm run generate -- 20
```

- `npm run generate -- N` (dans `server/`, ou via `docker compose exec server`) : génère une liste de N mots par LLM, les insère en base (transactionnel, idempotent) avec catégories, exemples, mots proches et confusions ; les partenaires manquants sont générés en cascade (limite : 2 × N).
- `LLM_PROVIDER` : `mistral`, `openai` ou `fireworks` (défaut : mistral si `MISTRAL_API_KEY` est définie, sinon openai). Le modèle est ajustable via `MISTRAL_MODEL` / `FIREWORKS_MODEL`.
- `BASE_PATH` (défaut : `/vocab`) : préfixe des liens générés — mettre vide en local (`BASE_PATH= docker compose up`) si l’app n’est pas derrière un proxy qui retire le préfixe.
