import { locoById, wagonById } from '../data';
import { newCond, type Unit } from './train';

export function makeUnit(uid: number, defId: string, kind: 'loco' | 'wagon', cond = 1): Unit {
  if (kind === 'loco') locoById(defId); else wagonById(defId);
  return { uid, defId, kind, cond: newCond(cond), upgrades: {}, km: 0, inspectedKm: null, inspectedDay: null, loadT: 0 };
}
