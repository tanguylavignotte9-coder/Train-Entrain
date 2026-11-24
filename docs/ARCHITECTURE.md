# Architecture et découpage en modules

Ce document propose (et applique) le découpage annoncé par le document de design : « détails que je gère sans validation ».

## Principes

- **Simulation séparée du rendu.** `TrainSim` (`src/sim/train.ts`) avance par pas fixe de 1/60 s, déterministe (RNG graine), sans accès au DOM.
  `Trip.update(dt)` accumule le temps réel et exécute des pas fixes ; le rendu (`src/render/scene.ts`) ne fait que lire l'état.
- **Génération reproductible.** Monde (`src/world/mapgen.ts`), profils de voie (`src/world/track.ts`), contrats, événements, météo et
  pannes dérivent de graines : une sauvegarde ne contient que l'état dynamique, la carte est régénérée depuis `state.seed`.
- **Données plutôt que code.** `src/data/*.json` : marchandises, industries, locomotives, wagons, **pièces** (usure, coût, immobilisation),
  améliorations, événements, époques. L'équilibrage se fait sans réécrire le code.
- **Pas de moteur externe.** Aucune bibliothèque d'exécution : canvas 2D, Web Audio, DOM. Dépendances de développement seulement
  (Electron, esbuild, TypeScript, Vitest).

## Modules

| Module | Rôle |
| --- | --- |
| `core` | `Rng` (mulberry32), bruit de valeur 2D/fBm, utilitaires |
| `data` | JSON typés + accès (`locoById`, `eraAt`, `expectations`…) |
| `world/mapgen` | relief, biomes, rivières, villes, régions, industries, réseau (MST + raccourcis), villes à raccorder, altitudes |
| `world/graph` | plus courts chemins (lignes coupées, lignes construites) |
| `world/track` | profil de chaque tronçon (pentes ≤ 3,2–3,6 %, courbes, tunnels, ponts), assemblage d'une route : limites, signaux, passages à niveau, travaux, zones neutres, gares de croisement |
| `sim/train` | physique, traction vapeur/diesel/électrique, adhérence, freinage, échauffement, usure, pannes, confort |
| `sim/weather` | calendrier, saisons, météo (pluie, neige, gel, brouillard, vent), jour/nuit |
| `economy` | stocks, production/consommation, commerce de fond, prix, événements |
| `game/state` | état, calendrier de jeu (1 an = 2 h), inflation, frais, nouvelle partie |
| `game/contracts` | tableau des contrats, composition de la rame, location de wagons, chargement |
| `game/actions` | achats, atelier, inspections, améliorations, infrastructure, finances |
| `game/trip` | séance de conduite : signaux, trafic adverse, passages à niveau, amendes, accidents, arrivée |
| `game/settle` | rémunération et réputation, report de l'usure dans la flotte |
| `game/goals`, `game/save` | objectifs à long terme ; sauvegardes versionnées (emplacements 1–5 + auto) |
| `render` | sprites procéduraux, props, décor à plans de parallaxe, éclairage, particules, météo |
| `audio` | synthèse sonore et musique générative |
| `ui` | HUD de conduite, hub (gare, train, atelier, matériel, carte, marché, réseau, finances, objectifs, menu) |

## Paramètres choisis

- **Résolution interne** : 640×360, mise à l'échelle entière (×2 en 720p, ×3 en 1080p, ×4 en 1440p) ; 1 px = 0,5 m ; relief vertical exagéré ×3,2.
- **Palette** : tons terreux chauds pour l'interface, palettes de saison pour la végétation, éclairage multiplicatif + sources additives.
- **Plans de parallaxe (8)** : ciel/nuages (0,02), montagnes lointaines (0,035), collines (0,08 et 0,16), crête boisée (0,34), objets
  de fond (0,5–0,9), voie (1,0), premier plan (1,5). Les plans lointains échantillonnent la **vraie** carte à un décalage perpendiculaire
  croissant : le paysage est cohérent d'un trajet à l'autre.
- **Marchandises** : charbon, minerai, bois, céréales, bétail, matériaux, produits manufacturés (conteneurs dès 1968), carburants (dès 1912),
  denrées périssables, courrier/bagages ; voyageurs 1ʳᵉ/2ᵉ/3ᵉ classes (3ᵉ classe disparaît vers 1960).
- **Offre et demande** : prix = base × m, m = clamp(2·(1 − stock/capacité), 0,35 ; 2,4) ; capacité = 45 jours de flux ; commerce de fond
  depuis le producteur le plus proche avec un taux de couverture propre à chaque couple ville/bien ; événements = multiplicateurs.
- **Rémunération** : tonnes × tarif(bien) × km × (0,5 + 0,5·m_destination) × réputation × entrepôts × inflation × ponctualité × état × précision d'arrêt.
- **Commandes** : voir le README ; tous les leviers sont aussi à la souris.
- **Sauvegarde** : JSON `{version, savedAt, meta, state}` ; `migrate()` gère les versions précédentes ; écriture atomique + `.bak` côté Electron.
- **Langue** : français (chaînes dans l'UI ; extraction i18n possible ensuite).

## Physique

`m·a = F_traction − (A + B·v + C·v²) − m·g·sinθ − F_courbe − F_frein` (par véhicule pour pente, courbe, résistance).

- Davis : A ≈ 20 N/t, B ≈ 0,6 N·s/m/t, C = 6 (loco) ou 1,2 (voitures) N·s²/m² ; ×1,6 en tunnel ; vent relatif ; ×2,2 au décollage.
- Courbe (Röckl) : 650/(R−55) N/kN ; limitation de vitesse √(a_lat·R) selon l'époque ; déraillement au-delà de ×1,42.
- Adhérence : μ = 0,27–0,31 × coefficient météo (mouillé 0,6–0,8, gel/neige 0,4–0,45, feuilles mortes) + sable ; patinage → force réduite et usure ;
  enrayage au freinage → méplats.
- Freinage : pression avec constante de temps (propagation le long de la rame), force par véhicule × état des freins × affaiblissement thermique,
  température par véhicule, frein moteur, usure proportionnelle à l'énergie dissipée.
- Vapeur : régulateur, détente, pression de chaudière (production = combustion × évaporation), niveau d'eau, couche de feu, charbon/eau au tender,
  injecteur, ventilateur, soupape, fusible. Diesel : puissance avec inertie, température moteur. Électrique : caténaire, chute de tension entre
  sous-stations, zones neutres, récupération, bimode.
- Usure : par kilomètre, charge, patinage, enrayage, surchauffes, météo ; performances dégradées puis pannes (aléa déterministe) ; réparations
  de fortune en ligne ou dépannage.
