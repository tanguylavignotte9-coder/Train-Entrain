import { addLedger, yearNow, type Game } from './state';

export interface Goal { id: string; name: string; desc: string; reward: number; rep: number; progress: (g: Game) => [number, number] }

export const GOALS: Goal[] = [
  { id: 'first', name: 'Premier convoi', desc: 'Réussir votre première livraison.', reward: 500, rep: 2, progress: g => [Math.min(1, g.state.stats.deliveries), 1] },
  { id: 'deliv10', name: 'Habitué du réseau', desc: 'Réussir 10 livraisons.', reward: 1500, rep: 3, progress: g => [g.state.stats.deliveries, 10] },
  { id: 'deliv50', name: 'Compagnie établie', desc: 'Réussir 50 livraisons.', reward: 8000, rep: 5, progress: g => [g.state.stats.deliveries, 50] },
  { id: 'deliv200', name: 'Institution nationale', desc: 'Réussir 200 livraisons.', reward: 40000, rep: 8, progress: g => [g.state.stats.deliveries, 200] },
  { id: 'regions', name: 'Relier toutes les régions', desc: 'Livrer ou charger dans chacune des régions du pays.', reward: 12000, rep: 8, progress: g => [g.state.stats.regionsServed.length, g.world.regions.length] },
  { id: 'rep50', name: 'Réputation solide', desc: 'Atteindre 50 de réputation.', reward: 3000, rep: 0, progress: g => [Math.round(g.state.reputation), 50] },
  { id: 'rep80', name: 'Compagnie de confiance', desc: 'Atteindre 80 de réputation.', reward: 15000, rep: 0, progress: g => [Math.round(g.state.reputation), 80] },
  { id: 'rich', name: 'Capital en croissance', desc: 'Posséder 100 000 Cr.', reward: 5000, rep: 2, progress: g => [Math.max(0, Math.round(g.state.money)), 100000] },
  { id: 'tycoon', name: 'Magnat du rail', desc: 'Posséder 1 000 000 Cr.', reward: 60000, rep: 6, progress: g => [Math.max(0, Math.round(g.state.money)), 1000000] },
  { id: 'tractions', name: 'Toutes les tractions', desc: 'Conduire une locomotive à vapeur, diesel et électrique.', reward: 10000, rep: 5, progress: g => [g.state.stats.tractions.length, 3] },
  { id: 'crises', name: 'Tenir face aux crises', desc: 'Traverser 5 crises économiques en restant solvable.', reward: 8000, rep: 4, progress: g => [g.state.stats.crisesSurvived, 5] },
  { id: 'builder', name: 'Bâtisseur', desc: 'Construire 3 lignes, dépôts, entrepôts ou électrifications.', reward: 6000, rep: 4, progress: g => [g.state.stats.built, 3] },
  { id: 'era1950', name: 'Traverser les époques : 1950', desc: 'Atteindre l’année 1950.', reward: 6000, rep: 3, progress: g => [Math.min(yearNow(g.state), 1950), 1950] },
  { id: 'era2000', name: 'Traverser les époques : 2000', desc: 'Atteindre l’année 2000.', reward: 25000, rep: 6, progress: g => [Math.min(yearNow(g.state), 2000), 2000] },
  { id: 'ontime', name: 'Ponctualité exemplaire', desc: 'Arriver à l’heure 20 fois.', reward: 6000, rep: 4, progress: g => [g.state.stats.onTime, 20] },
];

export const LEGEND_GOAL = 'legend';

/** Vérifie les objectifs et verse les récompenses. Renvoie ceux qui viennent d'être atteints. */
export function checkGoals(g: Game): { name: string; reward: number }[] {
  const s = g.state, got: { name: string; reward: number }[] = [];
  for (const goal of GOALS) {
    if (s.goalsDone.includes(goal.id)) continue;
    const [a, b] = goal.progress(g);
    if (a >= b) {
      s.goalsDone.push(goal.id); addLedger(s, `Objectif : ${goal.name}`, goal.reward); s.reputation = Math.min(100, s.reputation + goal.rep);
      got.push({ name: goal.name, reward: goal.reward }); s.message.push(`Objectif atteint : ${goal.name} !`);
    }
  }
  if (!s.goalsDone.includes(LEGEND_GOAL) && GOALS.every(x => s.goalsDone.includes(x.id))) {
    s.goalsDone.push(LEGEND_GOAL); addLedger(s, 'Compagnie légendaire', 100000);
    s.message.push('Tous les objectifs sont atteints : votre compagnie entre dans la légende ! Vous pouvez continuer à jouer librement.');
    got.push({ name: 'Compagnie légendaire', reward: 100000 });
  }
  return got;
}
