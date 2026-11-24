# Couverture du document de design

Correspondance entre chaque point du cahier des charges et son implémentation.

## Vision et piliers
| Pilier | Où |
| --- | --- |
| Conduite active, sans pilote automatique ni voyage rapide | `game/trip.ts`, `ui/hud.ts` ; seuls déplacements : trajets conduits (y compris « marche à vide ») |
| Un train qui vit : physique, usure, pannes, entretien | `sim/train.ts`, `game/actions.ts` (atelier), `data/parts.json` |
| Stratégie douce : quoi transporter, où, avec quel matériel, sans chrono permanent | `game/contracts.ts` ; ponctualité indulgente (`game/settle.ts`) |
| Monde dynamique : offre/demande, événements, progrès techniques | `economy/economy.ts`, `data/events.json`, `data/eras.json` |
| Ambiance cosy : pixel art HD, paysages procéduraux, lumière, météo, sons | `render/*`, `sim/weather.ts`, `audio/audio.ts` |

## Décisions actées
Windows + solo (Electron, `Lancer.bat`) · 2D vue de côté pixel art HD (`render`) · ton cosy · 1905 → aujourd'hui (`data/eras.json`, départ au choix 1905–2020)
· une seule difficulté (aucun réglage de difficulté, aucune aide activable) · physique simulée · grande carte fixe générée par graine (`world/mapgen.ts`)
· décor procédural · TypeScript + Electron sans moteur · lanceur `.bat` sans installeur · modules documentés dans `docs/ARCHITECTURE.md`.

## Boucle de jeu
1. **Préparer** : contrats (onglet Gare), rame et locomotive (Train), état du matériel (Atelier : inspection), plein de combustible/eau.
2. **Conduire** : vitesse, freinage, pentes, courbes, signalisation, météo, contraintes propres à chaque traction.
3. **Livrer** : paie = prix local × ponctualité × état de la marchandise × confort des voyageurs (× précision d'arrêt).
4. **Entretenir et investir** : réparations, pièces, améliorations, achat/vente de matériel.
5. **Choisir la suite** : nouveau contrat selon le marché.

## Simulation
Formule `m·a = F_traction − (A + Bv + Cv²) − m·g·sinθ − F_courbe − F_frein` (Davis) dans `TrainSim.step`.
Masse par véhicule + charge ; adhérence limitée (patinage, rail mouillé/gelé, sable) ; freinage retardé, usure et surchauffe en longue descente (frein moteur) ;
limites en courbe, aux aiguillages/gares, **selon l'état de la voie** (événement « Voie dégradée » : 50 km/h) ; pluie, neige, gel, vent.
Vapeur : régulateur, inverseur, pression, niveau d'eau, charbon à pelleter. Diesel : manette, température, carburant. Électrique : manette, tension en caténaire,
zones sans électrification (zones neutres, bimode).
Entretien : roues, essieux, freins, moteur/chaudière, graissage, attelages ; usure par km, charge, mauvais traitements, météo ; performances dégradées puis pannes ;
réparations en atelier (argent, pièces, immobilisation) ; inspections qui révèlent l'état réel.

## Monde et rendu
Carte fixe générée à la graine (relief, biomes, rivières, régions, villes et industries placées selon la géographie, réseau ferré) ; profil de voie réel (pentes, courbes,
tunnels, ponts, passages à niveau) qui alimente la physique ; décor déduit de la carte et de la position avec 8 plans de parallaxe ; cycle jour/nuit, météo, saisons,
fumée/vapeur, lumières dynamiques ; pixel art HD à échelle entière.

## Économie et époques
Stocks, production et consommation par ville ; prix évoluant avec stock et demande indépendamment du joueur ; fret (charbon, minerai, bois, céréales, bétail, matériaux, produits
manufacturés, carburants, denrées périssables) avec wagons, fragilité et délais propres ; voyageurs (classes), courrier et bagages, demande selon taille de la ville, réputation et **qualité du service** (score par ville mis à jour à chaque livraison) ;
événements (récoltes, pénuries, grèves, catastrophes, festivals, croissance/déclin) ; époques : technologies, marchandises et attentes des clients évoluent.
Rythme : trajets de 5 à 15 minutes, 1 an de jeu = 2 heures (`YEAR_SECONDS`).

## Progression
Locomotives de la vapeur 1895 aux électriques bimodes 2000 ; wagons voyageurs, marchandises générales, vrac, citernes, réfrigérés, conteneurs ; rame limitée par puissance, adhérence
et résistance des attelages ; améliorations (moteur, freins, capacité, confort, instruments de bord) et outillage d'atelier (niveaux 1–3) ; dépôt et atelier, entrepôts, nouvelles voies et
raccordements selon argent et réputation, électrification ; 15 objectifs à long terme (relier toutes les régions, tenir face aux crises, traverser les époques).

## Technique
Simulation à pas fixe séparée du rendu ; génération reproductible ; Canvas 2D ; données JSON ; sauvegardes locales versionnées à plusieurs emplacements ; tests automatiques de la
physique, de l'économie, du monde et du déroulement d'une partie (`npm test`) ; `Lancer.bat`.

## Décisions complémentaires (1 à 10)
1. Un train conduit à la fois, les autres au dépôt/atelier/en attente — `game/state.ts`, onglet Train.
2. Échelle de temps — `YEAR_SECONDS = 7200`, contrats calibrés pour 5–15 min.
3. 40–60 villes, 4–6 régions, distances comprimées — `mapgen.ts` (`CELL_M`, bornes de longueur de ligne).
4. Pays fictif inspiré de l'Europe, départ 1905, année au choix — écran « Nouvelle partie ».
5. Réalisme complet, un seul niveau — aucune option de difficulté.
6. Signaux et limitations, trafic PNJ simple (croisements dans des gares de croisement) — `world/track.ts`, `game/trip.ts`.
7. Pas de game over : amende, réparations, prêt bancaire, réputation — `game/trip.ts`, `game/actions.ts` (`ensureSolvent`).
8. Assets : pixel art dessiné par le code + surcharges PNG (IA retouchée) — `render/sprites.ts`, `assets/README.md`.
9. Bibliothèques légères autorisées — aucune nécessaire à l'exécution.
10. Lanceur `.bat` seul — `Lancer.bat`.
