# Assets pixel art (surcharges facultatives)

Le jeu dessine **tous** ses sprites par le code (locomotives, wagons, décor). Pour suivre la méthode « mix »
(génération par IA retouchée + pixel art programmatique pour les éléments répétitifs), un véhicule peut être
remplacé par une image PNG :

1. Déposez le PNG dans `assets/sprites/` (fond transparent, véhicule orienté vers la droite, 2 px = 1 m).
2. Déclarez-le dans `assets/manifest.js` (`window.TRAIN_ASSETS.sprites[<id du matériel>]`) avec la position des roues,
   de la cheminée, du phare, etc. (voir l'exemple dans le fichier).
3. Relancez le jeu : le sprite est utilisé à la place de la version générée ; les roues sont animées par le moteur.

Les identifiants de matériel sont ceux de `src/data/locomotives.json` et `src/data/wagons.json`.
