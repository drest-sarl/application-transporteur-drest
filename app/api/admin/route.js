import { NextResponse } from 'next/server';
import { fixer, q } from '../../../lib/db';
import { changerMode, annulerJournal, collecte, envoi, appliquerUn } from '../../../lib/moteur';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
// Actions de l'écran (protégées par le mot de passe via middleware.js)
export async function POST(req) {
  const f = await req.formData();
  const action = f.get('action');
  let message = 'ok';
  try {
    if (action === 'mode') await changerMode(f.get('valeur'));
    else if (action === 'pause') await fixer('pause', f.get('valeur') === 'oui' ? 'oui' : 'non');
    else if (action === 'annuler') await annulerJournal(Number(f.get('id')));
    else if (action === 'alerte_vue') await q('UPDATE alertes SET vue = true WHERE id = $1', [Number(f.get('id'))]);
    else if (action === 'alertes_toutes_vues') await q('UPDATE alertes SET vue = true WHERE NOT vue');
    else if (action === 'retirer') await q("UPDATE file SET etat = 'retire', traite_le = now() WHERE id = $1 AND etat IN ('attente','simule')", [Number(f.get('id'))]);
    else if (action === 'tester') message = await appliquerUn(Number(f.get('id')));
    else if (action === 'collecte') message = JSON.stringify(await collecte());
    else if (action === 'envoi') message = JSON.stringify(await envoi());
    else message = 'action inconnue';
  } catch (e) { message = 'erreur : ' + e.message; }
  return NextResponse.redirect(new URL('/?msg=' + encodeURIComponent(message.slice(0, 400)), req.url), 303);
}
