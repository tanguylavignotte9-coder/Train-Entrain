# Train Entrain

Jeu solo de simulation ferroviaire, **cosy mais exigeant** : vous conduisez chaque trajet vous-même et bâtissez une compagnie
dans un monde économique vivant, du début du XXᵉ siècle (1905) à aujourd'hui. PC Windows · 2D vue de côté · pixel art HD procédural ·
TypeScript + Electron, sans moteur de jeu externe.

## Lancer le jeu (Windows)

Double-cliquez sur **`Lancer.bat`** : il vérifie Node.js (≥ 18), installe les dépendances la première fois, compile puis démarre le jeu.
Aucun installeur. (Si Node.js manque, le lanceur ouvre la page de téléchargement.)

Autres commandes (toutes plateformes) :

```bash
npm install        # dépendances (Electron, esbuild, TypeScript, Vitest)
npm start          # compile puis lance dans Electron
npm run web        # mode navigateur : http://localhost:8080 (sauvegardes dans le navigateur)
npm test           # tests automatiques (physique, économie, monde, déroulement d'une partie)
npm run check      # vérification TypeScript
```

## Comment jouer

1. **Gare & contrats** : choisissez un contrat de fret, de voyageurs ou de courrier (prix selon l'offre et la demande locales).
2. **Train** : choisissez la locomotive, composez la rame (ou louez les wagons manquants), faites le plein, puis partez.
3. **Conduite active** (pas de pilote automatique, pas de voyage rapide) :

| Touche | Action |
| --- | --- |
| `W`/`↑` · `S`/`↓` | Traction / régulateur + · − |
| `←`/`A` · `→`/`D` | Serrer · desserrer le frein (réponse retardée) |
| `Espace` | Frein d'urgence (maintenir) |
| `H` | Sifflet (obligatoire pour dégager les passages à niveau) |
| `C` | Sablage (adhérence) |
| `G` · `I` · `B` · `R`/`F` | Vapeur : pelleter · injecteur · ventilateur · détente (inverseur) |
| `X`/`V` | Diesel/électrique : frein moteur + · − |
| `P` | Électrique : pantographe |
| `Échap` · `F1` · `M` · `F11` | Pause · aide · son · plein écran |

Souris : tous les leviers et boutons de la cabine sont cliquables.

4. **Livrer** : la paie dépend du prix local, de la ponctualité (indulgente), de l'état de la marchandise et du confort des voyageurs.
5. **Entretenir et investir** : atelier (inspection, réparations avec pièces et immobilisation), améliorations, nouveau matériel,
   dépôts, entrepôts, raccordements, électrification. Objectifs à long terme dans l'onglet *Objectifs*.

Pas de game over : amendes, réparations coûteuses, prêt bancaire et baisse de réputation sanctionnent les erreurs.

## Contenu

- **Physique** : `m·a = F_traction − (A + B·v + C·v²) − m·g·sinθ − F_courbe − F_frein` (Davis, adhérence, freinage retardé et échauffement,
  vapeur/diesel/électrique modélisés séparément). Détails : [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
- **Monde** : carte générée depuis une graine (relief, biomes, rivières, 40–60 villes, 4–6 régions, industries, réseau ferré, profils de voie).
- **Économie** : stocks, production/consommation, prix dynamiques, événements, époques de 1905 à 2020+.
- **Rendu** : canvas 2D 640×360 mis à l'échelle entière, 7 plans de parallaxe, jour/nuit, météo, saisons, lumières dynamiques, particules.
- **Audio** : tout est synthétisé (moteur, vapeur, rails, freins, sifflet, météo, musique générative douce).
- **Données** : `src/data/*.json` (marchandises, locomotives, wagons, pièces, améliorations, événements, époques, industries).
- **Couverture du cahier des charges** : [`docs/COUVERTURE.md`](docs/COUVERTURE.md).

## Assets

Tout est dessiné par le code ; des PNG peuvent surcharger les sprites de matériel (méthode « mix » IA retouchée + code) — voir [`assets/README.md`](assets/README.md).

## Structure

```
Lancer.bat            lanceur Windows (installe + démarre)
electron/             fenêtre Electron + sauvegardes locales (userData/saves)
scripts/              build (esbuild) et mini serveur du mode navigateur
src/core/             RNG déterministe, bruit, utilitaires
src/data/             données JSON typées
src/world/            génération de la carte, graphe ferroviaire, profils de voie, routes
src/sim/              physique du train, traction, usure, météo
src/economy/          production, prix, événements
src/game/             état, contrats, actions, trajet, règlement, objectifs, sauvegarde
src/render/           sprites, props, décor, éclairage, particules
src/audio/            synthèse sonore
src/ui/               HUD de conduite, hub (gare, atelier, carte...), carte du monde
tests/                tests Vitest
```
