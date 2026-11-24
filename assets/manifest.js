// Surcharges d'assets pixel art (facultatif).
// Pipeline « mix » : images générées par IA puis retouchées à la main, déposées dans assets/sprites/,
// et déclarées ici. Tout véhicule non listé garde son sprite dessiné par le code.
// Échelle : 2 pixels = 1 mètre ; l'avant du véhicule regarde vers la droite ; le dessous des roues est à 'axleY' pixels du bas.
//
// Exemple :
// window.TRAIN_ASSETS = {
//   sprites: {
//     s230: { file: 'sprites/s230.png', axleY: 8, wheels: [{ x: 20, r: 7, driver: true }, { x: 36, r: 7, driver: true }],
//             chimney: { x: 60, y: 6 }, headlight: { x: 71, y: 20 } }
//   }
// };
window.TRAIN_ASSETS = { sprites: {} };
